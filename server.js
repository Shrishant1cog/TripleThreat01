require("dotenv").config();

const crypto = require("node:crypto");
const path = require("node:path");
const express = require("express");
const session = require("express-session");
const PgSession = require("connect-pg-simple")(session);
const bcrypt = require("bcryptjs");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { Pool } = require("pg");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const NODE_ENV = process.env.NODE_ENV || "development";
const SESSION_SECRET = process.env.SESSION_SECRET || (NODE_ENV === "production" ? "" : "local-development-secret-change-me");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX || 8),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined
});
pool.on("connect", client => client.query("SET TIME ZONE 'Asia/Kolkata'").catch(err => console.error("Timezone setup failed:", err.message)));
pool.on("error", err => console.error("PostgreSQL pool error:", err.message));

const id = () => crypto.randomUUID();
const asyncRoute = fn => (req,res,next) => Promise.resolve(fn(req,res,next)).catch(next);
const fail = (status,message) => Object.assign(new Error(message),{status});
const text = value => typeof value === "string" ? value.trim() : "";
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const allowedTimeZones = new Set(["Asia/Kolkata","UTC","Asia/Dubai","Europe/London","America/New_York"]);

app.disable("x-powered-by");
app.set("trust proxy",1);
app.use(helmet({
  contentSecurityPolicy:{directives:{
    defaultSrc:["'self'"],scriptSrc:["'self'","'unsafe-inline'"],styleSrc:["'self'","'unsafe-inline'"],
    imgSrc:["'self'","data:"],connectSrc:["'self'"],baseUri:["'self'"],objectSrc:["'none'"],frameAncestors:["'none'"]
  }},
  crossOriginEmbedderPolicy:false
}));
app.use(express.json({limit:"1mb"}));
app.use(express.urlencoded({extended:false,limit:"20kb"}));

app.use(session({
  name:"easy_gateway.sid",
  secret:SESSION_SECRET,
  store:new PgSession({pool,tableName:"user_sessions",createTableIfMissing:true}),
  resave:false,saveUninitialized:false,rolling:true,
  cookie:{httpOnly:true,secure:NODE_ENV==="production",sameSite:"lax",maxAge:7*24*60*60*1000}
}));
app.use("/api/auth",rateLimit({windowMs:15*60*1000,limit:20,standardHeaders:"draft-8",legacyHeaders:false,message:{error:"Too many authentication attempts. Try again later."}}));

const SCHEMA_SQL = [
"CREATE TABLE IF NOT EXISTS shops(id TEXT PRIMARY KEY,name TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
"CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,full_name TEXT NOT NULL,email TEXT NOT NULL UNIQUE,password_hash TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'owner' CHECK(role IN ('owner','manager','staff')),created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
"CREATE TABLE IF NOT EXISTS shop_settings(shop_id TEXT PRIMARY KEY REFERENCES shops(id) ON DELETE CASCADE,currency TEXT NOT NULL DEFAULT 'INR',coin_threshold NUMERIC(12,2) NOT NULL DEFAULT 100 CHECK(coin_threshold>=1),timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',auto_purchase_enabled BOOLEAN NOT NULL DEFAULT FALSE,max_auto_purchase_amount NUMERIC(12,2) NOT NULL DEFAULT 5000 CHECK(max_auto_purchase_amount>=0),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
"CREATE TABLE IF NOT EXISTS products(id TEXT PRIMARY KEY,shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,name TEXT NOT NULL,sku TEXT NOT NULL,category TEXT NOT NULL DEFAULT 'General retail',unit TEXT NOT NULL DEFAULT 'piece',stock NUMERIC(14,3) NOT NULL DEFAULT 0 CHECK(stock>=0),reorder_at NUMERIC(14,3) NOT NULL DEFAULT 0 CHECK(reorder_at>=0),unit_cost NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK(unit_cost>=0),selling_price NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK(selling_price>=0),lead_time_days INTEGER NOT NULL DEFAULT 3 CHECK(lead_time_days BETWEEN 0 AND 180),expiry_date DATE,is_active BOOLEAN NOT NULL DEFAULT TRUE,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
"CREATE UNIQUE INDEX IF NOT EXISTS products_shop_sku_unique ON products(shop_id,LOWER(sku))",
"CREATE INDEX IF NOT EXISTS products_shop_active_idx ON products(shop_id,is_active)",
"CREATE INDEX IF NOT EXISTS products_expiry_idx ON products(expiry_date) WHERE is_active=TRUE",
"CREATE TABLE IF NOT EXISTS suppliers(id TEXT PRIMARY KEY,shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,name TEXT NOT NULL,contact_person TEXT NOT NULL DEFAULT '',email TEXT NOT NULL DEFAULT '',phone TEXT NOT NULL DEFAULT '',categories TEXT NOT NULL DEFAULT '',lead_time_days INTEGER NOT NULL DEFAULT 3 CHECK(lead_time_days BETWEEN 0 AND 180),minimum_order_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK(minimum_order_amount>=0),is_active BOOLEAN NOT NULL DEFAULT TRUE,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
"CREATE INDEX IF NOT EXISTS suppliers_shop_idx ON suppliers(shop_id,is_active)",
"CREATE TABLE IF NOT EXISTS customers(id TEXT PRIMARY KEY,shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,name TEXT NOT NULL,name_key TEXT NOT NULL,phone TEXT NOT NULL DEFAULT '',coin_balance BIGINT NOT NULL DEFAULT 0 CHECK(coin_balance>=0),lifetime_spend NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK(lifetime_spend>=0),order_count INTEGER NOT NULL DEFAULT 0 CHECK(order_count>=0),created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),UNIQUE(shop_id,name_key))",
"CREATE INDEX IF NOT EXISTS customers_shop_idx ON customers(shop_id,created_at DESC)",
"CREATE TABLE IF NOT EXISTS sales(id TEXT PRIMARY KEY,shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,product_id TEXT REFERENCES products(id) ON DELETE SET NULL,product_name TEXT NOT NULL,customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,customer_name TEXT NOT NULL DEFAULT 'Walk-in customer',quantity NUMERIC(14,3) NOT NULL CHECK(quantity>0),unit_price NUMERIC(14,2) NOT NULL CHECK(unit_price>=0),total NUMERIC(14,2) NOT NULL CHECK(total>=0),coins_earned BIGINT NOT NULL DEFAULT 0 CHECK(coins_earned>=0),created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
"CREATE INDEX IF NOT EXISTS sales_shop_created_idx ON sales(shop_id,created_at DESC)",
"CREATE INDEX IF NOT EXISTS sales_shop_product_idx ON sales(shop_id,product_id,created_at DESC)",
"CREATE TABLE IF NOT EXISTS loyalty_transactions(id TEXT PRIMARY KEY,shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,sale_id TEXT REFERENCES sales(id) ON DELETE SET NULL,delta BIGINT NOT NULL,reason TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
"CREATE INDEX IF NOT EXISTS loyalty_customer_idx ON loyalty_transactions(shop_id,customer_id,created_at DESC)",
"CREATE TABLE IF NOT EXISTS purchase_orders(id TEXT PRIMARY KEY,shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,supplier_id TEXT REFERENCES suppliers(id) ON DELETE SET NULL,status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved_awaiting_supplier','submitted','partially_received','received','cancelled')),source TEXT NOT NULL DEFAULT 'manual',total_cost NUMERIC(14,2) NOT NULL DEFAULT 0,created_by TEXT REFERENCES users(id) ON DELETE SET NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),received_at TIMESTAMPTZ)",
"CREATE INDEX IF NOT EXISTS purchase_orders_shop_idx ON purchase_orders(shop_id,created_at DESC)",
"CREATE TABLE IF NOT EXISTS purchase_order_items(id TEXT PRIMARY KEY,purchase_order_id TEXT NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,product_id TEXT REFERENCES products(id) ON DELETE SET NULL,product_name TEXT NOT NULL,quantity NUMERIC(14,3) NOT NULL CHECK(quantity>0),unit_cost NUMERIC(14,2) NOT NULL CHECK(unit_cost>=0),received_quantity NUMERIC(14,3) NOT NULL DEFAULT 0 CHECK(received_quantity>=0))",
"CREATE TABLE IF NOT EXISTS recycle_bin(id TEXT PRIMARY KEY,shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,product_id TEXT NOT NULL,product_snapshot JSONB NOT NULL,stock_at_expiry NUMERIC(14,3) NOT NULL DEFAULT 0,expiry_date DATE NOT NULL,reason TEXT NOT NULL,recycled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),restored_at TIMESTAMPTZ,deleted_at TIMESTAMPTZ)",
"CREATE INDEX IF NOT EXISTS recycle_bin_shop_active_idx ON recycle_bin(shop_id,recycled_at DESC) WHERE restored_at IS NULL AND deleted_at IS NULL",
"CREATE TABLE IF NOT EXISTS notifications(id TEXT PRIMARY KEY,shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,kind TEXT NOT NULL,title TEXT NOT NULL,message TEXT NOT NULL,payload JSONB NOT NULL DEFAULT '{}'::jsonb,is_read BOOLEAN NOT NULL DEFAULT FALSE,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
"CREATE INDEX IF NOT EXISTS notifications_shop_idx ON notifications(shop_id,created_at DESC)"
].join(";\n")+";\n";

async function initializeDatabase(){
  if(!process.env.DATABASE_URL)throw new Error("DATABASE_URL is missing. Configure PostgreSQL before starting Easy Gateway.");
  if(!SESSION_SECRET)throw new Error("SESSION_SECRET is required in production.");
  await pool.query(SCHEMA_SQL);
}
function publicUser(user){return {id:user.id,name:user.name||user.full_name,email:user.email,role:user.role,shopId:user.shopId||user.shop_id,shopName:user.shopName||user.shop_name};}
function requireAuth(req,res,next){
  if(!req.session||!req.session.user)return res.status(401).json({error:"Please sign in to continue.",code:"AUTH_REQUIRED"});
  req.user=req.session.user;next();
}
function ensureSameOrigin(req,res,next){
  if(!["POST","PUT","PATCH","DELETE"].includes(req.method))return next();
  const origin=req.get("origin");
  if(origin){try{if(new URL(origin).host!==req.get("host"))return res.status(403).json({error:"Cross-origin request blocked."});}catch(_){return res.status(403).json({error:"Invalid request origin."});}}
  if(!req.is("application/json"))return res.status(415).json({error:"API mutations require application/json."});
  next();
}
app.use("/api",ensureSameOrigin);
function regenerateSession(req){return new Promise((resolve,reject)=>req.session.regenerate(err=>err?reject(err):resolve()));}
function saveSession(req){return new Promise((resolve,reject)=>req.session.save(err=>err?reject(err):resolve()));}
function productDto(r){return {id:r.id,name:r.name,sku:r.sku,category:r.category,unit:r.unit,stock:Number(r.stock),reorderAt:Number(r.reorder_at),cost:Number(r.unit_cost),price:Number(r.selling_price),leadTimeDays:Number(r.lead_time_days),expiry:r.expiry_date||"",createdAt:r.created_at};}
function customerDto(r){return {id:r.id,name:r.name,phone:r.phone,coins:Number(r.coin_balance),spend:Number(r.lifetime_spend),orders:Number(r.order_count),createdAt:r.created_at};}
function saleDto(r){return {id:r.id,item:r.product_name+(Number(r.quantity)===1?"":" × "+Number(r.quantity)),productId:r.product_id,customer:r.customer_name,amount:Number(r.total),quantity:Number(r.quantity),coinsEarned:Number(r.coins_earned),time:r.created_at,status:"Recorded",createdAt:r.created_at};}
function supplierDto(r){return {id:r.id,name:r.name,contactPerson:r.contact_person,email:r.email,phone:r.phone,categories:r.categories,leadTimeDays:Number(r.lead_time_days),minimumOrderAmount:Number(r.minimum_order_amount),active:r.is_active};}
function notificationDto(r){return {id:r.id,kind:r.kind,title:r.title,message:r.message,payload:r.payload,isRead:r.is_read,createdAt:r.created_at};}
async function notify(shopId,kind,title,message,payload={}){
  await pool.query("INSERT INTO notifications(id,shop_id,kind,title,message,payload) VALUES($1,$2,$3,$4,$5,$6::jsonb)",[id(),shopId,kind,title,message,JSON.stringify(payload)]);
}
async function getShopSettings(shopId,client=pool){
  const r=await client.query("SELECT * FROM shop_settings WHERE shop_id=$1",[shopId]);
  if(!r.rowCount)throw fail(404,"Shop settings were not found.");
  const x=r.rows[0];
  return {currency:x.currency,coinThreshold:Number(x.coin_threshold),timezone:x.timezone,autoPurchaseEnabled:x.auto_purchase_enabled,maxAutoPurchaseAmount:Number(x.max_auto_purchase_amount)};
}
function validDate(value){
  if(!datePattern.test(String(value)))return false;
  const p=String(value).split("-").map(Number),d=new Date(Date.UTC(p[0],p[1]-1,p[2]));
  return d.getUTCFullYear()===p[0]&&d.getUTCMonth()===p[1]-1&&d.getUTCDate()===p[2];
}
async function expirySweep(){
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const expired=await client.query("SELECT p.* FROM products p LEFT JOIN shop_settings st ON st.shop_id=p.shop_id WHERE p.is_active=TRUE AND p.expiry_date IS NOT NULL AND p.expiry_date < (NOW() AT TIME ZONE COALESCE(st.timezone,'Asia/Kolkata'))::date FOR UPDATE OF p");
    for(const p of expired.rows){
      const recycleId=id();
      const snapshot={id:p.id,name:p.name,sku:p.sku,category:p.category,unit:p.unit,stock:Number(p.stock),reorderAt:Number(p.reorder_at),cost:Number(p.unit_cost),price:Number(p.selling_price),expiry:p.expiry_date,leadTimeDays:Number(p.lead_time_days)};
      await client.query("INSERT INTO recycle_bin(id,shop_id,product_id,product_snapshot,stock_at_expiry,expiry_date,reason) VALUES($1,$2,$3,$4::jsonb,$5,$6,'Expiry date passed')",[recycleId,p.shop_id,p.id,JSON.stringify(snapshot),p.stock,p.expiry_date]);
      await client.query("UPDATE products SET is_active=FALSE,stock=0,updated_at=NOW() WHERE id=$1",[p.id]);
      await client.query("INSERT INTO notifications(id,shop_id,kind,title,message,payload) VALUES($1,$2,'product_expired','Expired product moved to recycle bin',$3,$4::jsonb)",[id(),p.shop_id,p.name+" expired on "+p.expiry_date+" and was moved out of active inventory.",JSON.stringify({productId:p.id,recycleBinId:recycleId,expiryDate:p.expiry_date})]);
    }
    await client.query("COMMIT");
    return expired.rowCount;
  }catch(err){await client.query("ROLLBACK").catch(()=>{});throw err;}
  finally{client.release();}
}
let expirySweepInFlight=null;
async function runExpirySweep(){
  if(expirySweepInFlight)return expirySweepInFlight;
  expirySweepInFlight=expirySweep();
  try{return await expirySweepInFlight;}finally{expirySweepInFlight=null;}
}
app.use("/api",asyncRoute(async(req,res,next)=>{try{await runExpirySweep();}catch(err){console.error("Expiry sweep failed:",err.message);}next();}));

app.get("/healthz",asyncRoute(async(_req,res)=>{await pool.query("SELECT 1");res.json({ok:true,service:"easy-gateway",database:"connected",time:new Date().toISOString()});}));
app.get("/",(_req,res)=>res.sendFile(path.join(__dirname,"index.html")));
app.get("/favicon.ico",(_req,res)=>res.status(204).end());

app.post("/api/auth/register",asyncRoute(async(req,res)=>{
  const fullName=text(req.body.fullName),shopName=text(req.body.shopName),email=text(req.body.email).toLowerCase(),password=typeof req.body.password==="string"?req.body.password:"";
  if(fullName.length<2||fullName.length>100)throw fail(400,"Enter your full name (2–100 characters).");
  if(shopName.length<2||shopName.length>120)throw fail(400,"Enter your shop name (2–120 characters).");
  if(!emailPattern.test(email)||email.length>254)throw fail(400,"Enter a valid email address.");
  if(password.length<10||password.length>128)throw fail(400,"Choose a password between 10 and 128 characters.");
  const passwordHash=await bcrypt.hash(password,12),client=await pool.connect(),shopId=id(),userId=id();
  try{
    await client.query("BEGIN");
    if((await client.query("SELECT 1 FROM users WHERE email=$1",[email])).rowCount)throw fail(409,"An account already exists for this email. Sign in instead.");
    await client.query("INSERT INTO shops(id,name) VALUES($1,$2)",[shopId,shopName]);
    await client.query("INSERT INTO users(id,shop_id,full_name,email,password_hash,role) VALUES($1,$2,$3,$4,$5,'owner')",[userId,shopId,fullName,email,passwordHash]);
    await client.query("INSERT INTO shop_settings(shop_id) VALUES($1)",[shopId]);
    await client.query("COMMIT");
  }catch(err){await client.query("ROLLBACK").catch(()=>{});if(err.code==="23505")throw fail(409,"An account with this email already exists.");throw err;}
  finally{client.release();}
  await regenerateSession(req);req.session.user={id:userId,shopId,name:fullName,email,role:"owner",shopName};await saveSession(req);
  res.status(201).json({user:publicUser(req.session.user)});
}));
app.post("/api/auth/login",asyncRoute(async(req,res)=>{
  const email=text(req.body.email).toLowerCase(),password=typeof req.body.password==="string"?req.body.password:"";
  if(!emailPattern.test(email)||!password)throw fail(400,"Enter your email and password.");
  const result=await pool.query("SELECT u.id,u.shop_id,u.full_name,u.email,u.password_hash,u.role,s.name AS shop_name FROM users u JOIN shops s ON s.id=u.shop_id WHERE u.email=$1",[email]);
  if(!result.rowCount||!(await bcrypt.compare(password,result.rows[0].password_hash)))throw fail(401,"Email or password is incorrect.");
  const row=result.rows[0];await regenerateSession(req);
  req.session.user={id:row.id,shopId:row.shop_id,name:row.full_name,email:row.email,role:row.role,shopName:row.shop_name};
  await saveSession(req);res.json({user:publicUser(req.session.user)});
}));
app.get("/api/auth/me",(req,res)=>{if(!req.session||!req.session.user)return res.status(401).json({error:"Please sign in.",code:"AUTH_REQUIRED"});res.json({user:publicUser(req.session.user)});});
app.post("/api/auth/logout",asyncRoute(async(req,res)=>{if(req.session)await new Promise(resolve=>req.session.destroy(()=>resolve()));res.clearCookie("easy_gateway.sid",{httpOnly:true,sameSite:"lax",secure:NODE_ENV==="production"});res.json({ok:true});}));

async function calculateDashboard(shopId){
  const [stats,dailyRows,lowRows]=await Promise.all([
    pool.query("SELECT COALESCE(SUM(total) FILTER(WHERE created_at>=CURRENT_DATE),0) AS revenue_today,COUNT(*) FILTER(WHERE created_at>=CURRENT_DATE)::int AS orders_today,COALESCE(SUM(total) FILTER(WHERE created_at>=CURRENT_DATE-INTERVAL '1 day' AND created_at<CURRENT_DATE),0) AS revenue_yesterday,(SELECT COUNT(*)::int FROM products WHERE shop_id=$1 AND is_active=TRUE AND stock<=reorder_at) AS low_stock,(SELECT COUNT(*)::int FROM products WHERE shop_id=$1 AND is_active=TRUE) AS product_count,(SELECT COALESCE(SUM(coin_balance),0)::bigint FROM customers WHERE shop_id=$1) AS loyalty_coins FROM sales WHERE shop_id=$1",[shopId]),
    pool.query("SELECT TO_CHAR(CURRENT_DATE-days.n,'YYYY-MM-DD') AS day,COALESCE(SUM(s.total),0)::numeric(14,2) AS revenue,COUNT(s.id)::int AS order_count FROM generate_series(6,0,-1) AS days(n) LEFT JOIN sales s ON s.shop_id=$1 AND s.created_at>=(CURRENT_DATE-days.n)::timestamp AND s.created_at<(CURRENT_DATE-days.n+1)::timestamp GROUP BY days.n ORDER BY days.n DESC",[shopId]),
    pool.query("SELECT id,name,stock,reorder_at,unit,selling_price,unit_cost,sku FROM products WHERE shop_id=$1 AND is_active=TRUE AND stock<=reorder_at ORDER BY (reorder_at-stock) DESC,name LIMIT 5",[shopId])
  ]);
  const s=stats.rows[0],days=dailyRows.rows.map(r=>({day:r.day,revenue:Number(r.revenue),orders:Number(r.order_count)})),anomalies=[];
  for(let i=3;i<days.length;i++){
    const prior=days.slice(Math.max(0,i-3),i).map(d=>d.revenue).filter(v=>v>0);
    if(prior.length<2)continue;
    const expected=prior.reduce((a,b)=>a+b,0)/prior.length;
    if(expected<=0)continue;
    const variance=(days[i].revenue-expected)/expected*100;
    if(Math.abs(variance)>=30)anomalies.push({day:days[i].day,actual:days[i].revenue,expected:Math.round(expected*100)/100,variance:Math.round(variance*10)/10,status:"Review",basis:"Compared with prior 2–3 non-zero sales days"});
  }
  return {revenueToday:Number(s.revenue_today),ordersToday:Number(s.orders_today),revenueYesterday:Number(s.revenue_yesterday),lowStockCount:Number(s.low_stock),productCount:Number(s.product_count),loyaltyCoins:Number(s.loyalty_coins),dailySales:days,anomalies,lowStockProducts:lowRows.rows.map(r=>({id:r.id,name:r.name,sku:r.sku,stock:Number(r.stock),reorderAt:Number(r.reorder_at),unit:r.unit,cost:Number(r.unit_cost),price:Number(r.selling_price)}))};
}
app.get("/api/dashboard",requireAuth,asyncRoute(async(req,res)=>res.json(await calculateDashboard(req.user.shopId))));
app.get("/api/bootstrap",requireAuth,asyncRoute(async(req,res)=>{
  const shopId=req.user.shopId;
  const [settings,products,sales,customers,suppliers,bin,notifications,orders,dashboard]=await Promise.all([
    getShopSettings(shopId),
    pool.query("SELECT * FROM products WHERE shop_id=$1 AND is_active=TRUE ORDER BY name",[shopId]),
    pool.query("SELECT * FROM sales WHERE shop_id=$1 ORDER BY created_at DESC LIMIT 100",[shopId]),
    pool.query("SELECT * FROM customers WHERE shop_id=$1 ORDER BY coin_balance DESC,name",[shopId]),
    pool.query("SELECT * FROM suppliers WHERE shop_id=$1 AND is_active=TRUE ORDER BY name",[shopId]),
    pool.query("SELECT * FROM recycle_bin WHERE shop_id=$1 AND restored_at IS NULL AND deleted_at IS NULL ORDER BY recycled_at DESC",[shopId]),
    pool.query("SELECT * FROM notifications WHERE shop_id=$1 ORDER BY created_at DESC LIMIT 100",[shopId]),
    pool.query("SELECT po.*,sp.name AS supplier_name,(SELECT COUNT(*)::int FROM purchase_order_items i WHERE i.purchase_order_id=po.id) AS item_count FROM purchase_orders po LEFT JOIN suppliers sp ON sp.id=po.supplier_id WHERE po.shop_id=$1 ORDER BY po.created_at DESC LIMIT 100",[shopId]),
    calculateDashboard(shopId)
  ]);
  res.json({
    user:publicUser(req.user),settings,
    products:products.rows.map(productDto),sales:sales.rows.map(saleDto),customers:customers.rows.map(customerDto),suppliers:suppliers.rows.map(supplierDto),
    recycleBin:bin.rows.map(r=>({id:r.id,productId:r.product_id,product:r.product_snapshot,stockAtExpiry:Number(r.stock_at_expiry),expiry:r.expiry_date,reason:r.reason,recycledAt:r.recycled_at})),
    notifications:notifications.rows.map(notificationDto),
    purchaseOrders:orders.rows.map(r=>({id:r.id,supplierId:r.supplier_id,supplierName:r.supplier_name||"Not assigned",status:r.status,source:r.source,totalCost:Number(r.total_cost),itemCount:Number(r.item_count),createdAt:r.created_at})),
    dashboard
  });
}));

app.get("/api/products",requireAuth,asyncRoute(async(req,res)=>{
  const q=text(req.query.q),pattern="%"+q.replace(/[%_\\]/g,"\\$&")+"%";
  const r=await pool.query("SELECT * FROM products WHERE shop_id=$1 AND is_active=TRUE AND ($2='' OR name ILIKE $3 OR sku ILIKE $3 OR category ILIKE $3) ORDER BY name",[req.user.shopId,q,pattern]);
  res.json({products:r.rows.map(productDto)});
}));
app.post("/api/products",requireAuth,asyncRoute(async(req,res)=>{
  const name=text(req.body.name),sku=text(req.body.sku)||"EG-"+crypto.randomBytes(4).toString("hex").toUpperCase(),category=text(req.body.category)||"General retail",unit=text(req.body.unit)||"piece";
  const stock=Number(req.body.stock??0),reorderAt=Number(req.body.reorderAt??0),cost=Number(req.body.cost??0),price=Number(req.body.price??0),lead=Number(req.body.leadTimeDays??3),expiry=text(req.body.expiry)||null;
  if(!name||name.length>180||sku.length>100||category.length>100||unit.length>60)throw fail(400,"Product name is required; SKU/category/unit limits were exceeded.");
  if(![stock,reorderAt,cost,price,lead].every(Number.isFinite)||[stock,reorderAt,cost,price].some(v=>v<0)||!Number.isInteger(lead)||lead<0||lead>180)throw fail(400,"Enter valid non-negative inventory and price values.");
  if(expiry&&(!datePattern.test(expiry)||!validDate(expiry)))throw fail(400,"Enter a valid expiry date.");
  try{
    const r=await pool.query("INSERT INTO products(id,shop_id,name,sku,category,unit,stock,reorder_at,unit_cost,selling_price,lead_time_days,expiry_date) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *",[id(),req.user.shopId,name,sku,category,unit,stock,reorderAt,cost,price,lead,expiry]);
    await runExpirySweep();
    const active=await pool.query("SELECT * FROM products WHERE id=$1 AND shop_id=$2 AND is_active=TRUE",[r.rows[0].id,req.user.shopId]);
    if(!active.rowCount)return res.status(201).json({recycledImmediately:true,message:"The expiry date has passed; the item was moved to the recycle bin."});
    res.status(201).json({product:productDto(active.rows[0])});
  }catch(err){if(err.code==="23505")throw fail(409,"That SKU already exists in this shop.");throw err;}
}));
app.put("/api/products/:id",requireAuth,asyncRoute(async(req,res)=>{
  const x={name:text(req.body.name),sku:text(req.body.sku),category:text(req.body.category)||"General retail",unit:text(req.body.unit)||"piece",stock:Number(req.body.stock),reorderAt:Number(req.body.reorderAt),cost:Number(req.body.cost),price:Number(req.body.price),lead:Number(req.body.leadTimeDays??3),expiry:text(req.body.expiry)||null};
  if(!x.name||!x.sku||![x.stock,x.reorderAt,x.cost,x.price,x.lead].every(Number.isFinite)||[x.stock,x.reorderAt,x.cost,x.price].some(v=>v<0)||!Number.isInteger(x.lead)||x.lead<0||x.lead>180||(x.expiry&&(!datePattern.test(x.expiry)||!validDate(x.expiry))))throw fail(400,"Product details are invalid.");
  const r=await pool.query("UPDATE products SET name=$3,sku=$4,category=$5,unit=$6,stock=$7,reorder_at=$8,unit_cost=$9,selling_price=$10,lead_time_days=$11,expiry_date=$12,updated_at=NOW() WHERE id=$1 AND shop_id=$2 AND is_active=TRUE RETURNING *",[req.params.id,req.user.shopId,x.name,x.sku,x.category,x.unit,x.stock,x.reorderAt,x.cost,x.price,x.lead,x.expiry]);
  if(!r.rowCount)throw fail(404,"Product not found.");
  await runExpirySweep();
  const active=await pool.query("SELECT * FROM products WHERE id=$1 AND shop_id=$2 AND is_active=TRUE",[req.params.id,req.user.shopId]);
  res.json(active.rowCount?{product:productDto(active.rows[0])}:{recycledImmediately:true,message:"Product expired and was moved to the recycle bin."});
}));
app.post("/api/products/:id/stock-adjustments",requireAuth,asyncRoute(async(req,res)=>{
  const delta=Number(req.body.delta),reason=text(req.body.reason);
  if(!Number.isFinite(delta)||delta===0||Math.abs(delta)>1000000||reason.length<3||reason.length>240)throw fail(400,"Enter a non-zero adjustment and a reason (3–240 characters).");
  const r=await pool.query("UPDATE products SET stock=stock+$3,updated_at=NOW() WHERE id=$1 AND shop_id=$2 AND is_active=TRUE AND stock+$3>=0 RETURNING *",[req.params.id,req.user.shopId,delta]);
  if(!r.rowCount)throw fail(409,"Product not found or adjustment would make stock negative.");
  await notify(req.user.shopId,"stock_adjustment","Inventory adjusted",r.rows[0].name+": "+(delta>0?"+":"")+delta+". Reason: "+reason,{productId:req.params.id,delta,reason,userId:req.user.id});
  res.json({product:productDto(r.rows[0])});
}));

app.get("/api/sales",requireAuth,asyncRoute(async(req,res)=>{
  const r=await pool.query("SELECT * FROM sales WHERE shop_id=$1 ORDER BY created_at DESC LIMIT 300",[req.user.shopId]);
  res.json({sales:r.rows.map(saleDto)});
}));
app.post("/api/sales",requireAuth,asyncRoute(async(req,res)=>{
  const productId=text(req.body.productId),quantity=Number(req.body.quantity),customerName=text(req.body.customerName);
  if(!productId||!Number.isFinite(quantity)||quantity<=0||quantity>1000000)throw fail(400,"Select a product and enter a positive quantity.");
  if(customerName.length>120)throw fail(400,"Customer name must be 120 characters or fewer.");
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const pr=await client.query("SELECT * FROM products WHERE id=$1 AND shop_id=$2 AND is_active=TRUE FOR UPDATE",[productId,req.user.shopId]);
    if(!pr.rowCount)throw fail(404,"Product is not active. Check its expiry status.");
    const p=pr.rows[0],stock=Number(p.stock);
    if(stock<quantity)throw fail(409,"Insufficient stock. Only "+stock+" "+p.unit+" remain.");
    const total=Math.round(Number(p.selling_price)*quantity*100)/100;
    const setting=await client.query("SELECT coin_threshold FROM shop_settings WHERE shop_id=$1",[req.user.shopId]);
    const threshold=Number(setting.rows[0]?.coin_threshold||100);
    let customerId=null,coins=0,displayCustomer="Walk-in customer";
    if(customerName){
      const nameKey=customerName.toLocaleLowerCase("en-US");
      let customer=await client.query("SELECT * FROM customers WHERE shop_id=$1 AND name_key=$2 FOR UPDATE",[req.user.shopId,nameKey]);
      if(!customer.rowCount)customer=await client.query("INSERT INTO customers(id,shop_id,name,name_key) VALUES($1,$2,$3,$4) RETURNING *",[id(),req.user.shopId,customerName,nameKey]);
      customerId=customer.rows[0].id;displayCustomer=customer.rows[0].name;coins=Math.floor(total/threshold);
    }
    const saleId=id();
    await client.query("UPDATE products SET stock=stock-$3,updated_at=NOW() WHERE id=$1 AND shop_id=$2",[productId,req.user.shopId,quantity]);
    const sale=await client.query("INSERT INTO sales(id,shop_id,product_id,product_name,customer_id,customer_name,quantity,unit_price,total,coins_earned) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *",[saleId,req.user.shopId,productId,p.name,customerId,displayCustomer,quantity,p.selling_price,total,coins]);
    if(customerId){
      await client.query("UPDATE customers SET coin_balance=coin_balance+$3,lifetime_spend=lifetime_spend+$4,order_count=order_count+1 WHERE id=$1 AND shop_id=$2",[customerId,req.user.shopId,coins,total]);
      if(coins>0)await client.query("INSERT INTO loyalty_transactions(id,shop_id,customer_id,sale_id,delta,reason) VALUES($1,$2,$3,$4,$5,'Purchase reward')",[id(),req.user.shopId,customerId,saleId,coins]);
    }
    await client.query("COMMIT");
    res.status(201).json({sale:saleDto(sale.rows[0]),coinsEarned:coins});
  }catch(err){await client.query("ROLLBACK").catch(()=>{});throw err;}
  finally{client.release();}
}));
app.get("/api/customers",requireAuth,asyncRoute(async(req,res)=>{
  const r=await pool.query("SELECT * FROM customers WHERE shop_id=$1 ORDER BY coin_balance DESC,name",[req.user.shopId]);
  res.json({customers:r.rows.map(customerDto)});
}));

app.get("/api/suppliers",requireAuth,asyncRoute(async(req,res)=>{
  const r=await pool.query("SELECT * FROM suppliers WHERE shop_id=$1 AND is_active=TRUE ORDER BY name",[req.user.shopId]);
  res.json({suppliers:r.rows.map(supplierDto)});
}));
app.post("/api/suppliers",requireAuth,asyncRoute(async(req,res)=>{
  const name=text(req.body.name),contact=text(req.body.contactPerson),email=text(req.body.email),phone=text(req.body.phone),categories=text(req.body.categories),lead=Number(req.body.leadTimeDays??3),minimum=Number(req.body.minimumOrderAmount??0);
  if(!name||name.length>160||[contact,email,phone,categories].some(v=>v.length>200)||!Number.isInteger(lead)||lead<0||lead>180||!Number.isFinite(minimum)||minimum<0)throw fail(400,"Supplier details are invalid.");
  const r=await pool.query("INSERT INTO suppliers(id,shop_id,name,contact_person,email,phone,categories,lead_time_days,minimum_order_amount) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *",[id(),req.user.shopId,name,contact,email,phone,categories,lead,minimum]);
  res.status(201).json({supplier:supplierDto(r.rows[0])});
}));

async function getPurchasePlan(shopId){
  const r=await pool.query("SELECT p.*,COALESCE(SUM(s.quantity) FILTER(WHERE s.created_at>=NOW()-INTERVAL '30 days'),0) AS sold_30d,COALESCE((SELECT SUM(GREATEST(i.quantity-i.received_quantity,0)) FROM purchase_order_items i JOIN purchase_orders po ON po.id=i.purchase_order_id WHERE i.product_id=p.id AND po.shop_id=p.shop_id AND po.status IN ('draft','approved_awaiting_supplier','submitted','partially_received')),0) AS incoming FROM products p LEFT JOIN sales s ON s.product_id=p.id AND s.shop_id=p.shop_id WHERE p.shop_id=$1 AND p.is_active=TRUE GROUP BY p.id ORDER BY p.name",[shopId]);
  const items=r.rows.map(p=>{
    const average=Number(p.sold_30d)/30,lead=Number(p.lead_time_days);
    const target=average>0?Math.ceil(average*(lead+2)+Number(p.reorder_at)):Math.ceil(Number(p.reorder_at)*2);
    const incoming=Number(p.incoming),quantity=Math.max(0,target-Number(p.stock)-incoming);
    return {productId:p.id,name:p.name,sku:p.sku,unit:p.unit,stock:Number(p.stock),reorderAt:Number(p.reorder_at),soldLast30Days:Number(p.sold_30d),averageDailySales:Math.round(average*1000)/1000,leadTimeDays:lead,incoming,quantity,unitCost:Number(p.unit_cost),estimatedCost:Math.round(quantity*Number(p.unit_cost)*100)/100,basis:average>0?"30-day sales + lead time + reorder buffer":"No sales history: conservative reorder-level baseline"};
  }).filter(p=>p.quantity>0);
  return {items,estimatedTotal:Math.round(items.reduce((sum,p)=>sum+p.estimatedCost,0)*100)/100};
}
app.get("/api/purchase-plan",requireAuth,asyncRoute(async(req,res)=>res.json(await getPurchasePlan(req.user.shopId))));
app.get("/api/purchase-orders",requireAuth,asyncRoute(async(req,res)=>{
  const r=await pool.query("SELECT po.*,sp.name AS supplier_name,(SELECT COUNT(*)::int FROM purchase_order_items i WHERE i.purchase_order_id=po.id) AS item_count FROM purchase_orders po LEFT JOIN suppliers sp ON sp.id=po.supplier_id WHERE po.shop_id=$1 ORDER BY po.created_at DESC LIMIT 100",[req.user.shopId]);
  res.json({purchaseOrders:r.rows.map(x=>({id:x.id,status:x.status,supplierName:x.supplier_name||"Not assigned",source:x.source,totalCost:Number(x.total_cost),itemCount:Number(x.item_count),createdAt:x.created_at}))});
}));
app.post("/api/purchase-orders",requireAuth,asyncRoute(async(req,res)=>{
  const requested=Array.isArray(req.body.items)?req.body.items:[],supplierId=text(req.body.supplierId)||null;
  if(!requested.length||requested.length>500)throw fail(400,"Choose at least one purchase-plan item.");
  const client=await pool.connect(),orderId=id();
  try{
    await client.query("BEGIN");
    if(supplierId&&!((await client.query("SELECT id FROM suppliers WHERE id=$1 AND shop_id=$2 AND is_active=TRUE",[supplierId,req.user.shopId])).rowCount))throw fail(400,"The selected supplier is invalid.");
    let total=0;const lines=[];
    for(const e of requested){
      const productId=text(e.productId),qty=Number(e.quantity);
      if(!productId||!Number.isFinite(qty)||qty<=0||qty>1000000)throw fail(400,"A purchase quantity is invalid.");
      const pr=await client.query("SELECT * FROM products WHERE id=$1 AND shop_id=$2 AND is_active=TRUE FOR UPDATE",[productId,req.user.shopId]);
      if(!pr.rowCount)throw fail(404,"A product in the purchase plan is no longer active.");
      const p=pr.rows[0];total+=qty*Number(p.unit_cost);lines.push({product:p,quantity:qty});
    }
    await client.query("INSERT INTO purchase_orders(id,shop_id,supplier_id,status,source,total_cost,created_by) VALUES($1,$2,$3,'draft','manual',$4,$5)",[orderId,req.user.shopId,supplierId,total,req.user.id]);
    for(const line of lines)await client.query("INSERT INTO purchase_order_items(id,purchase_order_id,product_id,product_name,quantity,unit_cost) VALUES($1,$2,$3,$4,$5,$6)",[id(),orderId,line.product.id,line.product.name,line.quantity,line.product.unit_cost]);
    await client.query("COMMIT");
    await notify(req.user.shopId,"purchase_order","Purchase order draft created","Draft "+orderId.slice(0,8)+" created for "+lines.length+" products. It has not been sent to a supplier.",{purchaseOrderId:orderId});
    res.status(201).json({purchaseOrder:{id:orderId,status:"draft",totalCost:Math.round(total*100)/100,itemCount:lines.length}});
  }catch(err){await client.query("ROLLBACK").catch(()=>{});throw err;}
  finally{client.release();}
}));
app.post("/api/purchase-orders/:id/receive",requireAuth,asyncRoute(async(req,res)=>{
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const po=await client.query("SELECT * FROM purchase_orders WHERE id=$1 AND shop_id=$2 FOR UPDATE",[req.params.id,req.user.shopId]);
    if(!po.rowCount)throw fail(404,"Purchase order not found.");
    if(["received","cancelled"].includes(po.rows[0].status))throw fail(409,"This purchase order cannot be received.");
    const items=await client.query("SELECT * FROM purchase_order_items WHERE purchase_order_id=$1 FOR UPDATE",[req.params.id]);
    for(const item of items.rows){
      const outstanding=Number(item.quantity)-Number(item.received_quantity);
      if(outstanding<=0||!item.product_id)continue;
      const p=await client.query("UPDATE products SET stock=stock+$3,updated_at=NOW() WHERE id=$1 AND shop_id=$2 AND is_active=TRUE RETURNING id",[item.product_id,req.user.shopId,outstanding]);
      if(p.rowCount)await client.query("UPDATE purchase_order_items SET received_quantity=quantity WHERE id=$1",[item.id]);
    }
    const pending=await client.query("SELECT COUNT(*)::int AS n FROM purchase_order_items WHERE purchase_order_id=$1 AND received_quantity<quantity",[req.params.id]);
    const status=Number(pending.rows[0].n)>0?"partially_received":"received";
    await client.query("UPDATE purchase_orders SET status=$2,received_at=CASE WHEN $2='received' THEN NOW() ELSE received_at END WHERE id=$1",[req.params.id,status]);
    await client.query("COMMIT");res.json({ok:true,status});
  }catch(err){await client.query("ROLLBACK").catch(()=>{});throw err;}
  finally{client.release();}
}));

app.get("/api/recycle-bin",requireAuth,asyncRoute(async(req,res)=>{
  const r=await pool.query("SELECT * FROM recycle_bin WHERE shop_id=$1 AND restored_at IS NULL AND deleted_at IS NULL ORDER BY recycled_at DESC",[req.user.shopId]);
  res.json({items:r.rows.map(x=>({id:x.id,productId:x.product_id,product:x.product_snapshot,stockAtExpiry:Number(x.stock_at_expiry),expiry:x.expiry_date,reason:x.reason,recycledAt:x.recycled_at}))});
}));
app.post("/api/recycle-bin/:id/restore",requireAuth,asyncRoute(async(req,res)=>{
  const expiry=text(req.body.expiryDate);if(!validDate(expiry))throw fail(400,"Enter a valid corrected expiry date.");
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const rr=await client.query("SELECT * FROM recycle_bin WHERE id=$1 AND shop_id=$2 AND restored_at IS NULL AND deleted_at IS NULL FOR UPDATE",[req.params.id,req.user.shopId]);
    if(!rr.rowCount)throw fail(404,"Recycle-bin record not found.");
    const rb=rr.rows[0],tz=await client.query("SELECT timezone FROM shop_settings WHERE shop_id=$1",[req.user.shopId]);
    const today=await client.query("SELECT (NOW() AT TIME ZONE $1)::date AS today",[tz.rows[0]?.timezone||"Asia/Kolkata"]);
    if(expiry<String(today.rows[0].today).slice(0,10))throw fail(400,"Restore blocked: expiry date is still in the past.");
    const p=await client.query("SELECT * FROM products WHERE id=$1 AND shop_id=$2 FOR UPDATE",[rb.product_id,req.user.shopId]);
    if(!p.rowCount)throw fail(404,"Original product record is not available.");
    await client.query("UPDATE products SET expiry_date=$3,stock=$4,is_active=TRUE,updated_at=NOW() WHERE id=$1 AND shop_id=$2",[rb.product_id,req.user.shopId,expiry,rb.stock_at_expiry]);
    await client.query("UPDATE recycle_bin SET restored_at=NOW() WHERE id=$1",[rb.id]);
    await client.query("INSERT INTO notifications(id,shop_id,kind,title,message,payload) VALUES($1,$2,'product_restored','Product restored after expiry correction',$3,$4::jsonb)",[id(),req.user.shopId,p.rows[0].name+" was restored after its expiry date was corrected.",JSON.stringify({productId:rb.product_id,expiryDate:expiry})]);
    await client.query("COMMIT");res.json({ok:true});
  }catch(err){await client.query("ROLLBACK").catch(()=>{});throw err;}
  finally{client.release();}
}));
app.delete("/api/recycle-bin/:id",requireAuth,asyncRoute(async(req,res)=>{
  const r=await pool.query("UPDATE recycle_bin SET deleted_at=NOW() WHERE id=$1 AND shop_id=$2 AND restored_at IS NULL AND deleted_at IS NULL RETURNING id",[req.params.id,req.user.shopId]);
  if(!r.rowCount)throw fail(404,"Recycle-bin record not found.");res.json({ok:true});
}));

app.get("/api/notifications",requireAuth,asyncRoute(async(req,res)=>{
  const r=await pool.query("SELECT * FROM notifications WHERE shop_id=$1 ORDER BY created_at DESC LIMIT 100",[req.user.shopId]);
  res.json({notifications:r.rows.map(notificationDto)});
}));
app.post("/api/notifications/:id/read",requireAuth,asyncRoute(async(req,res)=>{
  const r=await pool.query("UPDATE notifications SET is_read=TRUE WHERE id=$1 AND shop_id=$2 RETURNING id",[req.params.id,req.user.shopId]);
  if(!r.rowCount)throw fail(404,"Notification not found.");res.json({ok:true});
}));
app.delete("/api/notifications",requireAuth,asyncRoute(async(req,res)=>{
  await pool.query("UPDATE notifications SET is_read=TRUE WHERE shop_id=$1",[req.user.shopId]);res.json({ok:true});
}));

app.get("/api/settings",requireAuth,asyncRoute(async(req,res)=>res.json({settings:await getShopSettings(req.user.shopId)})));
app.put("/api/settings",requireAuth,asyncRoute(async(req,res)=>{
  const coin=Number(req.body.coinThreshold),max=Number(req.body.maxAutoPurchaseAmount),timezone=text(req.body.timezone)||"Asia/Kolkata",enabled=req.body.autoPurchaseEnabled===true;
  if(!Number.isFinite(coin)||coin<1||coin>1000000||!Number.isFinite(max)||max<0||max>100000000)throw fail(400,"Coin threshold or purchase limit is invalid.");
  if(!allowedTimeZones.has(timezone))throw fail(400,"Choose a supported time zone.");
  await pool.query("UPDATE shop_settings SET coin_threshold=$2,max_auto_purchase_amount=$3,auto_purchase_enabled=$4,timezone=$5,updated_at=NOW() WHERE shop_id=$1",[req.user.shopId,coin,max,enabled,timezone]);
  res.json({settings:await getShopSettings(req.user.shopId)});
}));

async function runAutoPurchaseCycle(){
  const shops=await pool.query("SELECT shop_id,max_auto_purchase_amount FROM shop_settings WHERE auto_purchase_enabled=TRUE");
  for(const shop of shops.rows){
    try{
      const plan=await getPurchasePlan(shop.shop_id);if(!plan.items.length)continue;
      const open=await pool.query("SELECT 1 FROM purchase_orders WHERE shop_id=$1 AND source='automation' AND status IN ('approved_awaiting_supplier','submitted','partially_received') LIMIT 1",[shop.shop_id]);
      if(open.rowCount)continue;
      if(plan.estimatedTotal>Number(shop.max_auto_purchase_amount)){
        const today=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Kolkata",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
        const prior=await pool.query("SELECT 1 FROM notifications WHERE shop_id=$1 AND kind='purchase_limit' AND payload->>'date'=$2 LIMIT 1",[shop.shop_id,today]);
        if(!prior.rowCount)await notify(shop.shop_id,"purchase_limit","Purchase requires review","Suggested purchase total "+plan.estimatedTotal+" exceeds the configured auto-purchase limit of "+Number(shop.max_auto_purchase_amount)+".",{date:today,estimatedTotal:plan.estimatedTotal,limit:Number(shop.max_auto_purchase_amount)});
        continue;
      }
      const poId=id(),client=await pool.connect();
      try{
        await client.query("BEGIN");
        await client.query("INSERT INTO purchase_orders(id,shop_id,status,source,total_cost) VALUES($1,$2,'approved_awaiting_supplier','automation',$3)",[poId,shop.shop_id,plan.estimatedTotal]);
        for(const line of plan.items)await client.query("INSERT INTO purchase_order_items(id,purchase_order_id,product_id,product_name,quantity,unit_cost) VALUES($1,$2,$3,$4,$5,$6)",[id(),poId,line.productId,line.name,line.quantity,line.unitCost]);
        await client.query("COMMIT");
      }catch(err){await client.query("ROLLBACK").catch(()=>{});throw err;}
      finally{client.release();}
      await notify(shop.shop_id,"purchase_automation","Purchase order prepared automatically","An order totaling "+plan.estimatedTotal+" was created within your limit. External supplier submission is not connected; send it through an authorized supplier channel.",{purchaseOrderId:poId,estimatedTotal:plan.estimatedTotal});
    }catch(err){console.error("Auto-purchase cycle failed for shop",shop.shop_id,err.message);}
  }
}

app.use("/api",(req,res)=>res.status(404).json({error:"API endpoint not found."}));
app.use((err,req,res,next)=>{
  if(res.headersSent)return next(err);
  const status=Number(err.status)||500;if(status>=500)console.error("Request failed:",err);
  res.status(status).json({error:status>=500?"An unexpected server error occurred. Try again or contact support.":err.message});
});

let server;
async function start(){
  await initializeDatabase();
  await runExpirySweep().catch(err=>console.error("Initial expiry sweep failed:",err.message));
  server=app.listen(PORT,"0.0.0.0",()=>console.log("Easy Gateway listening on port "+PORT));
  setInterval(()=>runExpirySweep().catch(err=>console.error("Expiry sweep failed:",err.message)),60000).unref();
  setInterval(()=>runAutoPurchaseCycle().catch(err=>console.error("Auto-purchase cycle failed:",err.message)),15*60000).unref();
}
async function shutdown(signal){
  console.log("Received "+signal+"; shutting down gracefully.");
  if(server)await new Promise(resolve=>server.close(resolve));
  await pool.end();process.exit(0);
}
process.on("SIGTERM",()=>shutdown("SIGTERM"));
process.on("SIGINT",()=>shutdown("SIGINT"));
if(require.main===module)start().catch(err=>{console.error("Easy Gateway failed to start:",err.message);process.exit(1);});
module.exports={app,initializeDatabase,runExpirySweep,calculateDashboard,getPurchasePlan,validDate};
