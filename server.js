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
const QRCode = require("qrcode");
const nodemailer = require("nodemailer");
const { buildStockActions, buildSummaryText, normalizeCode, validEmail, nextOrderStatus } = require("./lib/retail-core");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const NODE_ENV = process.env.NODE_ENV || "development";
const ALLOW_DEV_SECRET = NODE_ENV === "development" && !process.env.RENDER;
const SESSION_SECRET = process.env.SESSION_SECRET || (ALLOW_DEV_SECRET ? "local-development-secret-change-me" : "");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX || 8),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  // Set the session time zone in the startup packet so the first query on a new
  // connection cannot race with a "SET TIME ZONE" round-trip (deprecated in pg 9).
  options: "-c timezone=Asia/Kolkata",
  ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined
});
pool.on("error", err => console.error("PostgreSQL pool error:", err.message));

const id = () => crypto.randomUUID();
const asyncRoute = fn => (req,res,next) => Promise.resolve(fn(req,res,next)).catch(next);
const fail = (status,message) => Object.assign(new Error(message),{status});
// Connection/authentication failures must never reach the browser as a raw
// driver error. Keep the detail in the server log and return one safe message.
const DATABASE_ERROR_CODES = new Set(["ECONNREFUSED","ECONNRESET","ENOTFOUND","ETIMEDOUT","EHOSTUNREACH","28P01","28000","3D000","57P01","53300","08000","08001","08003","08004","08006"]);
function isDatabaseError(err){
  const code=String((err&&err.code)||"");
  if(DATABASE_ERROR_CODES.has(code))return true;
  return /password authentication failed for user|role ".*" does not exist|database ".*" does not exist|connection terminated|connection refused|econnrefused|timeout expired|the database system is starting up|client has encountered a connection error/i.test(String((err&&err.message)||""));
}
function databaseErrorMessage(){return "Can't connect to the database. Check the database configuration and connection.";}
function startupErrorMessage(err){
  if(isDatabaseError(err))return databaseErrorMessage()+" Check DATABASE_URL and that PostgreSQL is running.";
  return (err&&err.message)||"Unknown startup error.";
}
const text = value => typeof value === "string" ? value.trim() : "";
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const allowedTimeZones = new Set(["Asia/Kolkata","UTC","Asia/Dubai","Europe/London","America/New_York"]);
// PostgreSQL DATE columns arrive as local-midnight Date objects. Use local getters so the
// calendar date never shifts through a UTC conversion, and keep text dates unchanged.
const dateOnly = value => {
  if(value==null||value==="")return "";
  if(value instanceof Date){
    if(Number.isNaN(value.getTime()))return "";
    return value.getFullYear()+"-"+String(value.getMonth()+1).padStart(2,"0")+"-"+String(value.getDate()).padStart(2,"0");
  }
  const raw=String(value);
  return datePattern.test(raw.slice(0,10))?raw.slice(0,10):raw;
};
const isBeforeDate = (value, reference) => dateOnly(value) < dateOnly(reference);

app.disable("x-powered-by");
app.set("trust proxy",1);
app.use(helmet({
  contentSecurityPolicy:{useDefaults:true,directives:{
    defaultSrc:["'self'"],scriptSrc:["'self'","'unsafe-inline'"],styleSrc:["'self'","'unsafe-inline'"],
    imgSrc:["'self'","data:"],connectSrc:["'self'"],baseUri:["'self'"],objectSrc:["'none'"],frameAncestors:["'none'"],
    // Helmet adds upgrade-insecure-requests by default. Behind HTTPS on Render that is
    // correct, but over plain HTTP on a LAN address it rewrites same-origin asset
    // requests to https:// and the browser fails them with ERR_SSL_PROTOCOL_ERROR.
    upgradeInsecureRequests:NODE_ENV==="production"?[]:null
  }},
  crossOriginEmbedderPolicy:false
}));
app.use(express.json({limit:"1mb"}));
app.use(express.urlencoded({extended:false,limit:"20kb"}));

app.use(session({
  name:"easy_gateway.sid",
  secret:SESSION_SECRET,
  store:new PgSession({pool,tableName:"user_sessions",createTableIfMissing:false}),
  resave:false,saveUninitialized:false,rolling:true,
  cookie:{httpOnly:true,secure:NODE_ENV==="production",sameSite:"lax",maxAge:7*24*60*60*1000}
}));
const authLimiter=rateLimit({windowMs:15*60*1000,limit:20,standardHeaders:"draft-8",legacyHeaders:false,message:{error:"Too many authentication attempts. Try again later."}});

const SCHEMA_SQL = [
"CREATE TABLE IF NOT EXISTS user_sessions(sid VARCHAR NOT NULL PRIMARY KEY,sess JSON NOT NULL,expire TIMESTAMP(6) NOT NULL)",
"CREATE INDEX IF NOT EXISTS user_sessions_expire_idx ON user_sessions(expire)",
"CREATE TABLE IF NOT EXISTS shops(id TEXT PRIMARY KEY,name TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
"ALTER TABLE shops ADD COLUMN IF NOT EXISTS public_slug TEXT",
"UPDATE shops SET public_slug='store-'||SUBSTRING(REPLACE(id,'-','') FROM 1 FOR 12) WHERE public_slug IS NULL OR public_slug=''",
"ALTER TABLE shops ALTER COLUMN public_slug SET DEFAULT ('store-' || SUBSTRING(MD5(random()::text || clock_timestamp()::text) FROM 1 FOR 10))",
"ALTER TABLE shops ALTER COLUMN public_slug SET NOT NULL",
"CREATE UNIQUE INDEX IF NOT EXISTS shops_public_slug_unique ON shops(public_slug)",
"CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,full_name TEXT NOT NULL,email TEXT NOT NULL UNIQUE,password_hash TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'owner' CHECK(role IN ('owner','manager','staff')),created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
"CREATE TABLE IF NOT EXISTS shop_settings(shop_id TEXT PRIMARY KEY REFERENCES shops(id) ON DELETE CASCADE,currency TEXT NOT NULL DEFAULT 'INR',coin_threshold NUMERIC(12,2) NOT NULL DEFAULT 100 CHECK(coin_threshold>=1),timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',auto_purchase_enabled BOOLEAN NOT NULL DEFAULT FALSE,max_auto_purchase_amount NUMERIC(12,2) NOT NULL DEFAULT 5000 CHECK(max_auto_purchase_amount>=0),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
"CREATE TABLE IF NOT EXISTS products(id TEXT PRIMARY KEY,shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,name TEXT NOT NULL,sku TEXT NOT NULL,category TEXT NOT NULL DEFAULT 'General retail',unit TEXT NOT NULL DEFAULT 'piece',stock NUMERIC(14,3) NOT NULL DEFAULT 0 CHECK(stock>=0),reorder_at NUMERIC(14,3) NOT NULL DEFAULT 0 CHECK(reorder_at>=0),unit_cost NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK(unit_cost>=0),selling_price NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK(selling_price>=0),lead_time_days INTEGER NOT NULL DEFAULT 3 CHECK(lead_time_days BETWEEN 0 AND 180),expiry_date DATE,is_active BOOLEAN NOT NULL DEFAULT TRUE,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
"ALTER TABLE products ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE",
"ALTER TABLE products ADD COLUMN IF NOT EXISTS barcode TEXT NOT NULL DEFAULT ''",
"ALTER TABLE products ADD COLUMN IF NOT EXISTS track_serials BOOLEAN NOT NULL DEFAULT FALSE",
"CREATE UNIQUE INDEX IF NOT EXISTS products_shop_sku_unique ON products(shop_id,LOWER(sku))",
"CREATE UNIQUE INDEX IF NOT EXISTS products_shop_barcode_unique ON products(shop_id,LOWER(barcode)) WHERE barcode<>''",
"CREATE INDEX IF NOT EXISTS products_shop_demo_idx ON products(shop_id,is_demo) WHERE is_demo=TRUE",
"CREATE INDEX IF NOT EXISTS products_shop_active_idx ON products(shop_id,is_active)",
"CREATE INDEX IF NOT EXISTS products_expiry_idx ON products(expiry_date) WHERE is_active=TRUE",
"CREATE TABLE IF NOT EXISTS suppliers(id TEXT PRIMARY KEY,shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,name TEXT NOT NULL,contact_person TEXT NOT NULL DEFAULT '',email TEXT NOT NULL DEFAULT '',phone TEXT NOT NULL DEFAULT '',categories TEXT NOT NULL DEFAULT '',lead_time_days INTEGER NOT NULL DEFAULT 3 CHECK(lead_time_days BETWEEN 0 AND 180),minimum_order_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK(minimum_order_amount>=0),is_active BOOLEAN NOT NULL DEFAULT TRUE,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
"CREATE INDEX IF NOT EXISTS suppliers_shop_idx ON suppliers(shop_id,is_active)",
"CREATE TABLE IF NOT EXISTS customers(id TEXT PRIMARY KEY,shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,name TEXT NOT NULL,name_key TEXT NOT NULL,phone TEXT NOT NULL DEFAULT '',coin_balance BIGINT NOT NULL DEFAULT 0 CHECK(coin_balance>=0),lifetime_spend NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK(lifetime_spend>=0),order_count INTEGER NOT NULL DEFAULT 0 CHECK(order_count>=0),created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),UNIQUE(shop_id,name_key))",
"CREATE INDEX IF NOT EXISTS customers_shop_idx ON customers(shop_id,created_at DESC)",
"CREATE TABLE IF NOT EXISTS sales(id TEXT PRIMARY KEY,shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,product_id TEXT REFERENCES products(id) ON DELETE SET NULL,product_name TEXT NOT NULL,customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,customer_name TEXT NOT NULL DEFAULT 'Walk-in customer',quantity NUMERIC(14,3) NOT NULL CHECK(quantity>0),unit_price NUMERIC(14,2) NOT NULL CHECK(unit_price>=0),total NUMERIC(14,2) NOT NULL CHECK(total>=0),coins_earned BIGINT NOT NULL DEFAULT 0 CHECK(coins_earned>=0),created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
"CREATE INDEX IF NOT EXISTS sales_shop_created_idx ON sales(shop_id,created_at DESC)",
"CREATE INDEX IF NOT EXISTS sales_shop_product_idx ON sales(shop_id,product_id,created_at DESC)",
"ALTER TABLE sales ADD COLUMN IF NOT EXISTS sale_group_id TEXT",
"UPDATE sales SET sale_group_id=id WHERE sale_group_id IS NULL",
"CREATE INDEX IF NOT EXISTS sales_group_idx ON sales(shop_id,sale_group_id)",
"CREATE TABLE IF NOT EXISTS loyalty_transactions(id TEXT PRIMARY KEY,shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,sale_id TEXT REFERENCES sales(id) ON DELETE SET NULL,delta BIGINT NOT NULL,reason TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
"CREATE INDEX IF NOT EXISTS loyalty_customer_idx ON loyalty_transactions(shop_id,customer_id,created_at DESC)",
"CREATE UNIQUE INDEX IF NOT EXISTS loyalty_sale_reason_unique ON loyalty_transactions(shop_id,sale_id,reason) WHERE sale_id IS NOT NULL",
"CREATE TABLE IF NOT EXISTS loyalty_redemptions(id TEXT PRIMARY KEY,shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,reward_code TEXT NOT NULL,reward_label TEXT NOT NULL,coins_spent BIGINT NOT NULL CHECK(coins_spent>0),reward_value NUMERIC(14,2) NOT NULL CHECK(reward_value>=0),status TEXT NOT NULL DEFAULT 'issued' CHECK(status IN ('issued','void')),voucher_code TEXT NOT NULL,created_by TEXT REFERENCES users(id) ON DELETE SET NULL,idempotency_key TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),voided_at TIMESTAMPTZ)",
"CREATE UNIQUE INDEX IF NOT EXISTS loyalty_redemptions_voucher_unique ON loyalty_redemptions(shop_id,voucher_code)",
"CREATE UNIQUE INDEX IF NOT EXISTS loyalty_redemptions_idem_unique ON loyalty_redemptions(shop_id,idempotency_key) WHERE idempotency_key IS NOT NULL",
"CREATE INDEX IF NOT EXISTS loyalty_redemptions_customer_idx ON loyalty_redemptions(shop_id,customer_id,created_at DESC)",
"CREATE TABLE IF NOT EXISTS purchase_orders(id TEXT PRIMARY KEY,shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,supplier_id TEXT REFERENCES suppliers(id) ON DELETE SET NULL,status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved_awaiting_supplier','submitted','partially_received','received','cancelled')),source TEXT NOT NULL DEFAULT 'manual',total_cost NUMERIC(14,2) NOT NULL DEFAULT 0,created_by TEXT REFERENCES users(id) ON DELETE SET NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),received_at TIMESTAMPTZ)",
"CREATE INDEX IF NOT EXISTS purchase_orders_shop_idx ON purchase_orders(shop_id,created_at DESC)",
"CREATE TABLE IF NOT EXISTS purchase_order_items(id TEXT PRIMARY KEY,purchase_order_id TEXT NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,product_id TEXT REFERENCES products(id) ON DELETE SET NULL,product_name TEXT NOT NULL,quantity NUMERIC(14,3) NOT NULL CHECK(quantity>0),unit_cost NUMERIC(14,2) NOT NULL CHECK(unit_cost>=0),received_quantity NUMERIC(14,3) NOT NULL DEFAULT 0 CHECK(received_quantity>=0))",
"CREATE TABLE IF NOT EXISTS stock_receipts(id TEXT PRIMARY KEY,shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,supplier_id TEXT REFERENCES suppliers(id) ON DELETE SET NULL,purchase_order_id TEXT REFERENCES purchase_orders(id) ON DELETE SET NULL,reference TEXT NOT NULL DEFAULT '',note TEXT NOT NULL DEFAULT '',received_by TEXT REFERENCES users(id) ON DELETE SET NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
"CREATE INDEX IF NOT EXISTS stock_receipts_shop_idx ON stock_receipts(shop_id,created_at DESC)",
"CREATE TABLE IF NOT EXISTS stock_receipt_items(id TEXT PRIMARY KEY,stock_receipt_id TEXT NOT NULL REFERENCES stock_receipts(id) ON DELETE CASCADE,product_id TEXT REFERENCES products(id) ON DELETE SET NULL,product_name TEXT NOT NULL,quantity NUMERIC(14,3) NOT NULL CHECK(quantity>0),unit_cost NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK(unit_cost>=0),expiry_date DATE,serials JSONB NOT NULL DEFAULT '[]'::jsonb)",
"CREATE INDEX IF NOT EXISTS stock_receipt_items_receipt_idx ON stock_receipt_items(stock_receipt_id)",
"CREATE TABLE IF NOT EXISTS product_identifiers(id TEXT PRIMARY KEY,shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,kind TEXT NOT NULL CHECK(kind IN ('barcode','sku','serial','rfid')),value TEXT NOT NULL,normalized_value TEXT NOT NULL,is_primary BOOLEAN NOT NULL DEFAULT FALSE,created_by TEXT REFERENCES users(id) ON DELETE SET NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),retired_at TIMESTAMPTZ,UNIQUE(shop_id,kind,normalized_value))",
"CREATE INDEX IF NOT EXISTS product_identifiers_product_idx ON product_identifiers(shop_id,product_id,kind) WHERE retired_at IS NULL",
"CREATE TABLE IF NOT EXISTS product_identifier_events(id TEXT PRIMARY KEY,shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,identifier_id TEXT REFERENCES product_identifiers(id) ON DELETE SET NULL,product_id TEXT NOT NULL,kind TEXT NOT NULL,value TEXT NOT NULL,action TEXT NOT NULL CHECK(action IN ('added','updated','retired')),actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
"CREATE INDEX IF NOT EXISTS product_identifier_events_shop_idx ON product_identifier_events(shop_id,created_at DESC)",
"CREATE TABLE IF NOT EXISTS serialized_units(id TEXT PRIMARY KEY,shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,serial TEXT NOT NULL,normalized_serial TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'in_stock' CHECK(status IN ('in_stock','sold','returned','written_off')),stock_receipt_id TEXT REFERENCES stock_receipts(id) ON DELETE SET NULL,sale_id TEXT REFERENCES sales(id) ON DELETE SET NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),UNIQUE(shop_id,normalized_serial))",
"CREATE INDEX IF NOT EXISTS serialized_units_product_idx ON serialized_units(shop_id,product_id,status)",
"CREATE TABLE IF NOT EXISTS inventory_movements(id TEXT PRIMARY KEY,shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,product_id TEXT REFERENCES products(id) ON DELETE SET NULL,type TEXT NOT NULL CHECK(type IN ('sale','stock_receipt','adjustment','expiry','restore','return','write_off')),quantity_delta NUMERIC(14,3) NOT NULL,balance_after NUMERIC(14,3) NOT NULL,unit_cost NUMERIC(14,2) NOT NULL DEFAULT 0,reason TEXT NOT NULL DEFAULT '',reference_type TEXT NOT NULL DEFAULT '',reference_id TEXT,actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
"CREATE INDEX IF NOT EXISTS inventory_movements_shop_idx ON inventory_movements(shop_id,created_at DESC)",
"CREATE INDEX IF NOT EXISTS inventory_movements_product_idx ON inventory_movements(shop_id,product_id,created_at DESC)",
"CREATE TABLE IF NOT EXISTS idempotency_keys(shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,idempotency_key TEXT NOT NULL,endpoint TEXT NOT NULL,request_hash TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'processing' CHECK(status IN ('processing','completed')),status_code INTEGER,response_json JSONB,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),PRIMARY KEY(shop_id,idempotency_key))",
"CREATE TABLE IF NOT EXISTS recycle_bin(id TEXT PRIMARY KEY,shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,product_id TEXT NOT NULL,product_snapshot JSONB NOT NULL,stock_at_expiry NUMERIC(14,3) NOT NULL DEFAULT 0,expiry_date DATE NOT NULL,reason TEXT NOT NULL,recycled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),restored_at TIMESTAMPTZ,deleted_at TIMESTAMPTZ)",
"ALTER TABLE recycle_bin ADD COLUMN IF NOT EXISTS recorded_quantity NUMERIC(14,3) CHECK(recorded_quantity>=0)",
"ALTER TABLE recycle_bin ADD COLUMN IF NOT EXISTS recorded_loss NUMERIC(14,2) CHECK(recorded_loss>=0)",
"ALTER TABLE recycle_bin ADD COLUMN IF NOT EXISTS waste_method TEXT NOT NULL DEFAULT ''",
"ALTER TABLE recycle_bin ADD COLUMN IF NOT EXISTS waste_note TEXT NOT NULL DEFAULT ''",
"ALTER TABLE recycle_bin ADD COLUMN IF NOT EXISTS waste_recorded_by TEXT REFERENCES users(id) ON DELETE SET NULL",
"ALTER TABLE recycle_bin ADD COLUMN IF NOT EXISTS waste_recorded_at TIMESTAMPTZ",
"CREATE INDEX IF NOT EXISTS recycle_bin_shop_active_idx ON recycle_bin(shop_id,recycled_at DESC) WHERE restored_at IS NULL AND deleted_at IS NULL",
"CREATE INDEX IF NOT EXISTS recycle_bin_shop_expiry_idx ON recycle_bin(shop_id,expiry_date) WHERE restored_at IS NULL",
"CREATE TABLE IF NOT EXISTS product_qr_tokens(id TEXT PRIMARY KEY,shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,token_hash TEXT NOT NULL UNIQUE,expires_at TIMESTAMPTZ NOT NULL,consumed_at TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
"CREATE INDEX IF NOT EXISTS product_qr_tokens_shop_idx ON product_qr_tokens(shop_id,created_at DESC)",
"CREATE TABLE IF NOT EXISTS product_import_qr_tokens(id TEXT PRIMARY KEY,token_hash TEXT NOT NULL UNIQUE,product_snapshot JSONB NOT NULL,expires_at TIMESTAMPTZ NOT NULL,consumed_at TIMESTAMPTZ,consumed_by_shop_id TEXT REFERENCES shops(id) ON DELETE SET NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
"ALTER TABLE product_import_qr_tokens ADD COLUMN IF NOT EXISTS demo_only BOOLEAN NOT NULL DEFAULT FALSE",
"CREATE INDEX IF NOT EXISTS product_import_qr_tokens_created_idx ON product_import_qr_tokens(created_at DESC)",
"CREATE TABLE IF NOT EXISTS customer_orders(id TEXT PRIMARY KEY,shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,customer_name TEXT NOT NULL,customer_phone TEXT NOT NULL,notes TEXT NOT NULL DEFAULT '',items JSONB NOT NULL,total NUMERIC(14,2) NOT NULL,status TEXT NOT NULL DEFAULT 'requested' CHECK(status IN ('requested','accepted','declined')),created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
"ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS customer_email TEXT NOT NULL DEFAULT ''",
"ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS customer_address TEXT NOT NULL DEFAULT ''",
"ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS reference_code TEXT",
"ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS email_status TEXT NOT NULL DEFAULT 'not_sent'",
"UPDATE customer_orders SET reference_code='EG-'||UPPER(SUBSTRING(REPLACE(id,'-','') FROM 1 FOR 8)) WHERE reference_code IS NULL OR reference_code=''",
"CREATE UNIQUE INDEX IF NOT EXISTS customer_orders_reference_unique ON customer_orders(shop_id,reference_code)",
"ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS client_request_id TEXT",
"CREATE UNIQUE INDEX IF NOT EXISTS customer_orders_client_request_unique ON customer_orders(shop_id,client_request_id) WHERE client_request_id IS NOT NULL",
"ALTER TABLE customer_orders DROP CONSTRAINT IF EXISTS customer_orders_status_check",
"ALTER TABLE customer_orders ADD CONSTRAINT customer_orders_status_check CHECK(status IN ('requested','accepted','declined','ready','fulfilled','cancelled'))",
"CREATE INDEX IF NOT EXISTS customer_orders_shop_idx ON customer_orders(shop_id,created_at DESC)",
"CREATE TABLE IF NOT EXISTS customer_order_events(id TEXT PRIMARY KEY,shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,order_id TEXT NOT NULL REFERENCES customer_orders(id) ON DELETE CASCADE,type TEXT NOT NULL,actor TEXT NOT NULL DEFAULT 'shop',message TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
"CREATE INDEX IF NOT EXISTS customer_order_events_order_idx ON customer_order_events(shop_id,order_id,created_at)",
"CREATE TABLE IF NOT EXISTS email_outbox(id TEXT PRIMARY KEY,shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,order_id TEXT REFERENCES customer_orders(id) ON DELETE SET NULL,kind TEXT NOT NULL,to_email TEXT NOT NULL,subject TEXT NOT NULL,body_text TEXT NOT NULL,body_html TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','sending','sent','failed')),attempts INTEGER NOT NULL DEFAULT 0,last_error TEXT NOT NULL DEFAULT '',provider TEXT NOT NULL DEFAULT '',provider_message_id TEXT NOT NULL DEFAULT '',dedupe_key TEXT NOT NULL UNIQUE,next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),sent_at TIMESTAMPTZ)",
"CREATE INDEX IF NOT EXISTS email_outbox_pending_idx ON email_outbox(status,next_attempt_at) WHERE status IN ('queued','failed')",
"CREATE TABLE IF NOT EXISTS notifications(id TEXT PRIMARY KEY,shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,kind TEXT NOT NULL,title TEXT NOT NULL,message TEXT NOT NULL,payload JSONB NOT NULL DEFAULT '{}'::jsonb,is_read BOOLEAN NOT NULL DEFAULT FALSE,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
"CREATE INDEX IF NOT EXISTS notifications_shop_idx ON notifications(shop_id,created_at DESC)"
].join(";\n")+";\n";

async function initializeDatabase(){
  if(!process.env.DATABASE_URL)throw new Error("DATABASE_URL is missing. Configure PostgreSQL before starting Easy Gateway.");
  if(!SESSION_SECRET)throw new Error("SESSION_SECRET is required outside local development.");
  const client=await pool.connect();
  try{
    await client.query("SELECT pg_advisory_lock(71303718)");
    await client.query(SCHEMA_SQL);
  }finally{
    await client.query("SELECT pg_advisory_unlock(71303718)").catch(()=>{});
    client.release();
  }
}
function publicUser(user){return {id:user.id,name:user.name||user.full_name,email:user.email,role:user.role,shopId:user.shopId||user.shop_id,shopName:user.shopName||user.shop_name,publicSlug:user.publicSlug||user.public_slug||""};}
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
function productDto(r){return {id:r.id,name:r.name,sku:r.sku,barcode:r.barcode||"",category:r.category,unit:r.unit,stock:Number(r.stock),reorderAt:Number(r.reorder_at),cost:Number(r.unit_cost),price:Number(r.selling_price),leadTimeDays:Number(r.lead_time_days),expiry:dateOnly(r.expiry_date),trackSerials:!!r.track_serials,isDemo:!!r.is_demo,qrImported:!!r.is_demo,createdAt:r.created_at};}
function customerDto(r){return {id:r.id,name:r.name,phone:r.phone,coins:Number(r.coin_balance),spend:Number(r.lifetime_spend),orders:Number(r.order_count),createdAt:r.created_at};}
function customerOrderDto(r){
  return {id:r.id,reference:r.reference_code||String(r.id||"").slice(0,12),name:r.customer_name,phone:r.customer_phone,email:r.customer_email||"",address:r.customer_address||"",notes:r.notes,items:r.items,total:Number(r.total),status:r.status,statusLabel:ORDER_STATUS_LABELS[r.status]||r.status,emailStatus:r.email_status||"not_sent",createdAt:r.created_at,updatedAt:r.updated_at};
}
function saleDto(r){return {id:r.id,groupId:r.sale_group_id||r.id,item:r.product_name+(Number(r.quantity)===1?"":" × "+Number(r.quantity)),productId:r.product_id,customer:r.customer_name,amount:Number(r.total),quantity:Number(r.quantity),coinsEarned:Number(r.coins_earned),time:r.created_at,status:"Recorded",createdAt:r.created_at};}
function supplierDto(r){return {id:r.id,name:r.name,contactPerson:r.contact_person,email:r.email,phone:r.phone,categories:r.categories,leadTimeDays:Number(r.lead_time_days),minimumOrderAmount:Number(r.minimum_order_amount),active:r.is_active};}
function notificationDto(r){return {id:r.id,kind:r.kind,title:r.title,message:r.message,payload:r.payload,isRead:r.is_read,createdAt:r.created_at};}
async function notify(shopId,kind,title,message,payload={},client=pool){
  await client.query("INSERT INTO notifications(id,shop_id,kind,title,message,payload) VALUES($1,$2,$3,$4,$5,$6::jsonb)",[id(),shopId,kind,title,message,JSON.stringify(payload)]);
}
async function getShopSettings(shopId,client=pool){
  const r=await client.query("SELECT * FROM shop_settings WHERE shop_id=$1",[shopId]);
  if(!r.rowCount)throw fail(404,"Shop settings were not found.");
  const x=r.rows[0];
  return {currency:x.currency,coinThreshold:Number(x.coin_threshold),timezone:x.timezone,autoPurchaseEnabled:x.auto_purchase_enabled,maxAutoPurchaseAmount:Number(x.max_auto_purchase_amount)};
}

const LOYALTY_REWARDS=[
  {code:"SAVE50",label:"₹50 voucher",coins:100,value:50,description:"Redeem 100 coins for a ₹50 shop voucher."},
  {code:"SAVE150",label:"₹150 voucher",coins:250,value:150,description:"Redeem 250 coins for a ₹150 shop voucher."},
  {code:"SAVE350",label:"₹350 voucher",coins:500,value:350,description:"Redeem 500 coins for a ₹350 shop voucher."}
];
const ORDER_STATUS_LABELS={requested:"Awaiting shop confirmation",accepted:"Confirmed by shop",declined:"Not accepted by shop",ready:"Ready for pickup or delivery",fulfilled:"Completed",cancelled:"Cancelled"};

function rewardFor(code){
  const normalized=normalizeCode(code);
  return LOYALTY_REWARDS.find(reward=>normalizeCode(reward.code)===normalized)||null;
}
function voucherCode(){return "EG-V-"+crypto.randomBytes(4).toString("hex").toUpperCase();}
function orderReference(){return "EG-"+crypto.randomBytes(4).toString("hex").toUpperCase();}

async function shopContext(shopId,client=pool){
  const r=await client.query("SELECT s.name,st.currency,st.timezone,(SELECT email FROM users WHERE shop_id=s.id AND role='owner' ORDER BY created_at LIMIT 1) AS owner_email FROM shops s LEFT JOIN shop_settings st ON st.shop_id=s.id WHERE s.id=$1",[shopId]);
  if(!r.rowCount)throw fail(404,"Shop was not found.");
  return {name:r.rows[0].name,currency:r.rows[0].currency||"INR",timezone:r.rows[0].timezone||"Asia/Kolkata",ownerEmail:r.rows[0].owner_email||""};
}

function orderItemsText(items){
  const list=Array.isArray(items)?items:[];
  return list.map(item=>"- "+item.name+" × "+Number(item.quantity)+" — "+Number(item.lineTotal).toFixed(2)).join("\n");
}
function emailLayout(shop,heading,paragraphs,extraHtml){
  const body=(paragraphs||[]).map(p=>"<p style=\"margin:0 0 12px;line-height:1.6\">"+p+"</p>").join("");
  return "<!doctype html><html><body style=\"margin:0;background:#f5f7f3;color:#243528;font-family:system-ui,-apple-system,Segoe UI,sans-serif;padding:22px\"><div style=\"max-width:600px;margin:0 auto;background:#fff;border:1px solid #e1e8dd;border-radius:14px;padding:26px\"><div style=\"font-size:11px;letter-spacing:1px;color:#5b7d5c;font-weight:800\">EASY GATEWAY · "+escapeHtml(shop.name||"Shop")+"</div><h1 style=\"font-size:23px;line-height:1.25;margin:10px 0 16px\">"+escapeHtml(heading)+"</h1>"+body+(extraHtml||"")+"<p style=\"border-top:1px solid #e8ede5;padding-top:14px;margin-top:20px;font-size:12px;color:#7b8777;line-height:1.6\">This message was sent by Easy Gateway on behalf of "+escapeHtml(shop.name||"the shop")+". Easy Gateway does not collect payment for customer order requests.</p></div></body></html>";
}

function orderEmailContent(kind,order,shop){
  const ref=order.referenceCode||order.reference_code||String(order.id||"").slice(0,12);
  const customer=order.customerName||order.customer_name||order.name||"Customer";
  const items=order.items||[];
  const total=Number(order.total||0).toFixed(2);
  const address=order.customerAddress||order.customer_address||"";
  const phone=order.customerPhone||order.customer_phone||order.phone||"";
  const lines=orderItemsText(items);
  if(kind==="requested_customer"){
    return {
      subject:"Order request "+ref+" received — "+shop.name,
      text:["Hello "+customer+",","","We received your order request "+ref+" at "+shop.name+".","","Items:",lines,"","Estimated total: "+total,"Delivery address: "+address,"","This is a request, not a confirmed sale. The shop will review availability and contact you on "+phone+". No payment has been collected by Easy Gateway.","","You can check the status with your order reference and phone number.","","Easy Gateway"].join("\n"),
      html:emailLayout(shop,"We received your order request",[
        "Hello "+escapeHtml(customer)+",",
        "We received order request <strong>"+escapeHtml(ref)+"</strong> at "+escapeHtml(shop.name)+".",
        "This is a request, not a confirmed sale. The shop will review availability and contact you on "+escapeHtml(phone)+". <strong>No payment has been collected.</strong>"
      ],"<div style=\"background:#f8faf6;border:1px solid #e7eae3;border-radius:9px;padding:13px;margin:14px 0\"><strong>Items</strong><pre style=\"white-space:pre-wrap;font:inherit;font-size:13px;margin:8px 0 0\">"+escapeHtml(lines)+"</pre><div style=\"margin-top:10px\"><strong>Estimated total:</strong> "+escapeHtml(total)+"</div><div><strong>Delivery address:</strong> "+escapeHtml(address)+"</div></div>")
    };
  }
  if(kind==="requested_shop"){
    return {
      subject:"New order request "+ref+" — "+customer,
      text:["New customer order request","","Reference: "+ref,"Customer: "+customer,"Phone: "+phone,"Email: "+(order.customerEmail||order.customer_email||"")+"","Address: "+address,"","Items:",lines,"","Estimated total: "+total,"Notes: "+(order.notes||"None"),"","This request is awaiting confirmation. Review it in Easy Gateway → Customer orders.","","Easy Gateway"].join("\n"),
      html:emailLayout(shop,"New customer order request",[
        "Reference <strong>"+escapeHtml(ref)+"</strong> from "+escapeHtml(customer)+".",
        "Phone: "+escapeHtml(phone)+"<br>Email: "+escapeHtml(order.customerEmail||order.customer_email||"")+"<br>Address: "+escapeHtml(address),
        "This request is awaiting confirmation. No stock has been reserved and no payment has been collected."
      ],"<div style=\"background:#f8faf6;border:1px solid #e7eae3;border-radius:9px;padding:13px;margin:14px 0\"><strong>Items</strong><pre style=\"white-space:pre-wrap;font:inherit;font-size:13px;margin:8px 0 0\">"+escapeHtml(lines)+"</pre><div style=\"margin-top:10px\"><strong>Estimated total:</strong> "+escapeHtml(total)+"</div><div><strong>Notes:</strong> "+escapeHtml(order.notes||"None")+"</div></div>")
    };
  }
  const statusCopy={
    accepted:{subject:"Order "+ref+" confirmed — "+shop.name,heading:"Your order was confirmed",body:"The shop has confirmed availability for order "+ref+". Please contact the shop to arrange pickup or delivery. No payment has been collected by Easy Gateway."},
    declined:{subject:"Order "+ref+" could not be accepted — "+shop.name,heading:"Your order was not accepted",body:"The shop could not accept order "+ref+". Please contact the shop if you would like to discuss alternatives. No payment has been collected."},
    ready:{subject:"Order "+ref+" is ready — "+shop.name,heading:"Your order is ready",body:"Order "+ref+" is ready for pickup or delivery. Please contact the shop to arrange collection. No payment has been collected by Easy Gateway."},
    fulfilled:{subject:"Order "+ref+" completed — "+shop.name,heading:"Order completed",body:"Order "+ref+" has been marked completed by the shop. Thank you for shopping with "+shop.name+"."},
    cancelled:{subject:"Order "+ref+" cancelled — "+shop.name,heading:"Order cancelled",body:"Order "+ref+" has been cancelled. Please contact the shop if you have questions."}
  }[kind]||{subject:"Order "+ref+" update — "+shop.name,heading:"Order update",body:"The status of order "+ref+" changed to "+kind+"."};
  return {
    subject:statusCopy.subject,
    text:["Hello "+customer+",","",statusCopy.body,"","Reference: "+ref,"Estimated total: "+total,"","Easy Gateway"].join("\n"),
    html:emailLayout(shop,statusCopy.heading,["Hello "+escapeHtml(customer)+",",escapeHtml(statusCopy.body),"Reference: <strong>"+escapeHtml(ref)+"</strong><br>Estimated total: "+escapeHtml(total)])
  };
}

async function queueEmail(client,{shopId,orderId=null,kind,to,subject,text,html,dedupeKey}){
  if(!to)return false;
  const r=await client.query("INSERT INTO email_outbox(id,shop_id,order_id,kind,to_email,subject,body_text,body_html,dedupe_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(dedupe_key) DO NOTHING RETURNING id",[id(),shopId,orderId,kind,to,subject,text,html||"",dedupeKey]);
  return r.rowCount>0;
}
async function enqueueOrderEmail(client,shop,order,kind,to){
  if(!to)return false;
  const content=orderEmailContent(kind,order,shop);
  const dedupeKey="order:"+order.id+":"+kind;
  return queueEmail(client,{shopId:order.shopId||order.shop_id,orderId:order.id,kind,to,subject:content.subject,text:content.text,html:content.html,dedupeKey});
}
async function refreshOrderEmailStatus(client,orderId){
  await client.query("UPDATE customer_orders SET email_status=(SELECT CASE WHEN COUNT(*)>0 AND BOOL_AND(status='sent') THEN 'sent' WHEN COUNT(*) FILTER(WHERE status='failed')>0 THEN 'failed' WHEN COUNT(*)>0 THEN 'queued' ELSE 'not_sent' END FROM email_outbox WHERE order_id=$1) WHERE id=$1",[orderId]);
}

function emailProviderConfig(env=process.env){
  const smtp=text(env.SMTP_URL),resend=text(env.RESEND_API_KEY);
  return {provider:smtp?"smtp":resend?"resend":"",from:text(env.EMAIL_FROM)||"Easy Gateway <no-reply@easygateway.local>",smtp,resend};
}
async function sendEmailThroughProvider(message,config){
  if(config.provider==="smtp"){
    const transport=nodemailer.createTransport(config.smtp);
    const info=await transport.sendMail({from:config.from,to:message.to_email,subject:message.subject,text:message.body_text,html:message.body_html||undefined});
    return {provider:"smtp",id:info.messageId||""};
  }
  if(config.provider==="resend"){
    const response=await fetch("https://api.resend.com/emails",{method:"POST",headers:{Authorization:"Bearer "+config.resend,"Content-Type":"application/json"},body:JSON.stringify({from:config.from,to:[message.to_email],subject:message.subject,text:message.body_text,html:message.body_html||undefined}),signal:AbortSignal.timeout(15000)});
    const payload=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(payload.message||payload.error||("Email provider returned HTTP "+response.status+"."));
    return {provider:"resend",id:payload.id||""};
  }
  throw new Error("Email delivery is not configured. Set SMTP_URL or RESEND_API_KEY on the server.");
}
async function processEmailOutbox(limit=10,forcedConfig=null){
  const config=forcedConfig||emailProviderConfig();
  if(!config.provider)return {configured:false,processed:0,sent:0,failed:0};
  const claimed=await pool.query("UPDATE email_outbox SET status='sending',attempts=attempts+1,provider=$2,updated_at=NOW() WHERE id IN (SELECT id FROM email_outbox WHERE status IN ('queued','failed') AND attempts<5 AND next_attempt_at<=NOW() ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED) RETURNING *",[limit,config.provider]);
  let sent=0,failed=0;
  for(const message of claimed.rows){
    try{
      const result=await sendEmailThroughProvider(message,config);
      await pool.query("UPDATE email_outbox SET status='sent',provider=$2,provider_message_id=$3,last_error='',sent_at=NOW(),updated_at=NOW() WHERE id=$1",[message.id,result.provider,result.id||""]);
      sent++;
    }catch(err){
      const error=String(err.message||"Email delivery failed.").slice(0,500);
      await pool.query("UPDATE email_outbox SET status='failed',last_error=$2,next_attempt_at=NOW()+($3||' minutes')::interval,updated_at=NOW() WHERE id=$1",[message.id,error,String(Math.min(60,Math.max(5,message.attempts*5)))]);
      failed++;
    }
    if(message.order_id)await refreshOrderEmailStatus(pool,message.order_id).catch(()=>{});
  }
  return {configured:true,processed:claimed.rowCount,sent,failed};
}
let emailProcessing=null;
function scheduleEmailProcessing(){
  if(emailProcessing)return emailProcessing;
  emailProcessing=processEmailOutbox().catch(err=>console.error("Email outbox failed:",err.message)).finally(()=>{emailProcessing=null;});
  return emailProcessing;
}

async function recordMovement(client,{shopId,productId,type,delta,balanceAfter,unitCost=0,reason="",referenceType="",referenceId=null,actorId=null}){
  await client.query("INSERT INTO inventory_movements(id,shop_id,product_id,type,quantity_delta,balance_after,unit_cost,reason,reference_type,reference_id,actor_user_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",[id(),shopId,productId,type,delta,balanceAfter,unitCost,reason,referenceType,referenceId,actorId]);
}
async function readIdempotentReplay(req,client,endpoint){
  const key=text(req.get("Idempotency-Key")||(req.body&&req.body.idempotencyKey));
  if(!key)return null;
  if(!/^[A-Za-z0-9._:-]{8,160}$/.test(key))throw fail(400,"Idempotency-Key must be 8–160 characters using letters, numbers, dot, dash, colon or underscore.");
  const prior=await client.query("SELECT * FROM idempotency_keys WHERE shop_id=$1 AND idempotency_key=$2",[req.user.shopId,key]);
  if(!prior.rowCount||prior.rows[0].status!=="completed")return null;
  const hash=crypto.createHash("sha256").update(JSON.stringify(req.body||{})).digest("hex");
  const row=prior.rows[0];
  if(row.endpoint!==endpoint||row.request_hash!==hash)throw fail(409,"This idempotency key was already used for a different request. Start a new request without reusing the key.");
  return {body:row.response_json,statusCode:row.status_code||201,replayed:true};
}
async function withIdempotency(req,client,endpoint,handler,statusCode=201){
  const key=text(req.get("Idempotency-Key")||(req.body&&req.body.idempotencyKey));
  if(!key)return {body:await handler(),statusCode,replayed:false};
  if(!/^[A-Za-z0-9._:-]{8,160}$/.test(key))throw fail(400,"Idempotency-Key must be 8–160 characters using letters, numbers, dot, dash, colon or underscore.");
  const hash=crypto.createHash("sha256").update(JSON.stringify(req.body||{})).digest("hex");
  const inserted=await client.query("INSERT INTO idempotency_keys(shop_id,idempotency_key,endpoint,request_hash) VALUES($1,$2,$3,$4) ON CONFLICT(shop_id,idempotency_key) DO NOTHING RETURNING idempotency_key",[req.user.shopId,key,endpoint,hash]);
  if(!inserted.rowCount){
    const prior=await client.query("SELECT * FROM idempotency_keys WHERE shop_id=$1 AND idempotency_key=$2 FOR UPDATE",[req.user.shopId,key]);
    const row=prior.rows[0];
    if(row.endpoint!==endpoint||row.request_hash!==hash)throw fail(409,"This idempotency key was already used for a different request. Start a new sale without reusing the key.");
    if(row.status==="completed")return {body:row.response_json,statusCode:row.status_code||statusCode,replayed:true};
    throw fail(409,"This request is still being processed. Wait a moment before retrying.");
  }
  const body=await handler();
  await client.query("UPDATE idempotency_keys SET status='completed',status_code=$3,response_json=$4::jsonb,updated_at=NOW() WHERE shop_id=$1 AND idempotency_key=$2",[req.user.shopId,key,statusCode,JSON.stringify(body)]);
  return {body,statusCode,replayed:false};
}

async function syncProductIdentifiers(client,shopId,product,actorId){
  const entries=[];
  if(product.barcode)entries.push({kind:"barcode",value:product.barcode});
  if(product.sku)entries.push({kind:"sku",value:product.sku});
  for(const entry of entries){
    const normalized=normalizeCode(entry.value);
    const existing=await client.query("SELECT * FROM product_identifiers WHERE shop_id=$1 AND kind=$2 AND normalized_value=$3 FOR UPDATE",[shopId,entry.kind,normalized]);
    if(existing.rowCount&&existing.rows[0].product_id!==product.id)throw fail(409,"That "+entry.kind+" already belongs to another product in this shop.");
    let identifierId;
    if(existing.rowCount){
      identifierId=existing.rows[0].id;
      await client.query("UPDATE product_identifiers SET product_id=$2,value=$3,is_primary=TRUE,retired_at=NULL WHERE id=$1",[identifierId,product.id,entry.value]);
    }else{
      identifierId=id();
      try{
        await client.query("INSERT INTO product_identifiers(id,shop_id,product_id,kind,value,normalized_value,is_primary,created_by) VALUES($1,$2,$3,$4,$5,$6,TRUE,$7)",[identifierId,shopId,product.id,entry.kind,entry.value,normalized,actorId]);
      }catch(err){
        if(err.code==="23505")throw fail(409,"That "+entry.kind+" already belongs to another product in this shop.");
        throw err;
      }
    }
    await client.query("INSERT INTO product_identifier_events(id,shop_id,identifier_id,product_id,kind,value,action,actor_user_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",[id(),shopId,identifierId,product.id,entry.kind,entry.value,existing.rowCount?"updated":"added",actorId]);
  }
  const keepKinds=entries.map(e=>e.kind),keepValues=entries.map(e=>normalizeCode(e.value));
  const stale=await client.query("SELECT * FROM product_identifiers WHERE shop_id=$1 AND product_id=$2 AND kind IN ('barcode','sku') AND is_primary=TRUE AND retired_at IS NULL AND NOT (kind=ANY($3::text[]) AND normalized_value=ANY($4::text[])) FOR UPDATE",[shopId,product.id,keepKinds,keepValues]);
  for(const row of stale.rows){
    await client.query("UPDATE product_identifiers SET retired_at=NOW() WHERE id=$1",[row.id]);
    await client.query("INSERT INTO product_identifier_events(id,shop_id,identifier_id,product_id,kind,value,action,actor_user_id) VALUES($1,$2,$3,$4,$5,$6,'retired',$7)",[id(),shopId,row.id,product.id,row.kind,row.value,actorId]);
  }
}
function parseSerialList(value){
  if(!Array.isArray(value))return [];
  const seen=new Set(),out=[];
  for(const raw of value){
    const serial=text(raw);
    if(!serial)continue;
    if(serial.length>120)throw fail(400,"Each serial number must be 120 characters or fewer.");
    const normalized=normalizeCode(serial);
    if(seen.has(normalized))throw fail(409,"Serial \""+serial+"\" appears more than once in this request.");
    seen.add(normalized);out.push(serial);
  }
  return out;
}
function validDate(value){
  if(!datePattern.test(String(value)))return false;
  const p=String(value).split("-").map(Number),d=new Date(Date.UTC(p[0],p[1]-1,p[2]));
  return d.getUTCFullYear()===p[0]&&d.getUTCMonth()===p[1]-1&&d.getUTCDate()===p[2];
}

function validDateRange(from,to){return validDate(from)&&validDate(to)&&from<=to;}
function createQrToken(){return crypto.randomBytes(32).toString("base64url");}
function hashQrToken(token){return crypto.createHash("sha256").update(String(token)).digest("hex");}
function isLoopbackHostname(hostname){
  const host=String(hostname||"").toLowerCase().replace(/^\[|\]$/g,"");
  return host==="localhost"||host==="::1"||host==="0.0.0.0"||host.endsWith(".localhost")||/^127\./.test(host);
}
function resolvePublicOrigin(req,env=process.env){
  const configured=text(env.PUBLIC_APP_URL);
  const production=String(env.NODE_ENV||"").trim().toLowerCase()==="production";
  // In production the QR origin must come from configuration. Falling back to
  // the request Host header would let a forged header or a stale deployment
  // emit a QR that points at the wrong domain.
  if(production&&!configured)throw fail(412,"Production QR links require PUBLIC_APP_URL, for example https://shop.example.com.");
  let origin;
  try{origin=new URL(configured||(req.protocol+"://"+req.get("host")));}
  catch{throw fail(412,"PUBLIC_APP_URL must be a valid URL, for example http://192.168.1.20:3000.");}
  if(!["http:","https:"].includes(origin.protocol))throw fail(412,"PUBLIC_APP_URL must use http (local development only) or https.");
  if(origin.username||origin.password)throw fail(412,"PUBLIC_APP_URL must not contain credentials.");
  if(origin.pathname!=="/"||origin.search||origin.hash)throw fail(412,"PUBLIC_APP_URL must be an origin only, for example https://shop.example.com.");
  if(isLoopbackHostname(origin.hostname))throw fail(412,"QR links cannot point at localhost because a phone cannot open them. Set PUBLIC_APP_URL to this PC's LAN address, for example http://192.168.1.20:3000, then restart the server.");
  // Production QRs must always be HTTPS. Without this guard a proxy or a stale
  // PUBLIC_APP_URL can silently emit an HTTP QR that every production app rejects.
  if(production&&origin.protocol!=="https:")throw fail(412,"Production QR links must use HTTPS. Set PUBLIC_APP_URL to the public https URL, for example https://shop.example.com, then restart the server.");
  return origin.origin;
}
function escapeHtml(value){
  const map={"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"};
  return String(value==null?"":value).replace(/[&<>"']/g,c=>map[c]);
}
function qrProductDetails(row){
  return {shopName:String(row.shop_name||"Shop"),name:String(row.name||"Product"),sku:String(row.sku||""),category:String(row.category||"General retail"),unit:String(row.unit||"piece"),stock:Number(row.stock)||0,price:Number(row.selling_price)||0,expiry:row.expiry_date?String(row.expiry_date).slice(0,10):""};
}
function qrScanPage(details){
  const esc=escapeHtml;
  if(!details)return '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>QR code unavailable · Easy Gateway</title><style>body{font:16px/1.55 system-ui,sans-serif;background:#f5f7f3;color:#243528;margin:0;padding:24px}.card{max-width:520px;margin:8vh auto;background:white;border:1px solid #e1e8dd;border-radius:16px;padding:28px}a{color:#315d3d}</style><main class="card"><h1>QR code unavailable</h1><p>This QR code has already been scanned, expired, or the product is no longer active.</p><p>Ask the shop operator to generate a fresh code.</p><a href="/">Open Easy Gateway</a></main></html>';
  const expiry=details.expiry||"Not set";
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>'+esc(details.name)+' · Easy Gateway product</title><style>body{font:15px/1.55 system-ui,-apple-system,Segoe UI,sans-serif;background:#f5f7f3;color:#243528;margin:0;padding:22px}.card{max-width:560px;margin:3vh auto;background:white;border:1px solid #e1e8dd;border-radius:16px;padding:26px;box-shadow:0 10px 30px #203a2910}.eyebrow{font-size:11px;letter-spacing:1px;color:#5b7d5c;font-weight:800}.shop{color:#7a8876;font-size:13px}h1{font-size:27px;line-height:1.15;margin:10px 0}dl{display:grid;grid-template-columns:130px 1fr;gap:10px;margin:22px 0}dt{color:#788474}dd{margin:0;font-weight:650;overflow-wrap:anywhere}.note{border-top:1px solid #e8ede5;padding-top:14px;font-size:12px;color:#7b8777}a{color:#315d3d}@media(max-width:420px){dl{grid-template-columns:1fr;gap:3px}dd{margin-bottom:10px}}</style></head><body><main class="card"><div class="eyebrow">EASY GATEWAY · PRODUCT DETAILS</div><h1>'+esc(details.name)+'</h1><div class="shop">'+esc(details.shopName)+'</div><dl><dt>SKU</dt><dd>'+esc(details.sku||"Not set")+'</dd><dt>Category</dt><dd>'+esc(details.category)+'</dd><dt>Available stock</dt><dd>'+esc(details.stock.toLocaleString("en-IN"))+' '+esc(details.unit)+'</dd><dt>Selling price</dt><dd>₹'+esc(details.price.toLocaleString("en-IN",{minimumFractionDigits:2,maximumFractionDigits:2}))+'</dd><dt>Expiry date</dt><dd>'+esc(expiry)+'</dd></dl><p class="note">This is a one-time QR link. It expires after two minutes and cannot be reused after a successful scan. Purchase cost and other private inventory settings are not shown.</p><p><a href="/">Easy Gateway</a></p></main></body></html>';
}
async function expirySweep(){
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const expired=await client.query("SELECT p.* FROM products p LEFT JOIN shop_settings st ON st.shop_id=p.shop_id WHERE p.is_active=TRUE AND p.expiry_date IS NOT NULL AND p.expiry_date < (NOW() AT TIME ZONE COALESCE(st.timezone,'Asia/Kolkata'))::date FOR UPDATE OF p");
    for(const p of expired.rows){
      const recycleId=id(),expiryDate=dateOnly(p.expiry_date);
      const snapshot={id:p.id,name:p.name,sku:p.sku,category:p.category,unit:p.unit,stock:Number(p.stock),reorderAt:Number(p.reorder_at),cost:Number(p.unit_cost),price:Number(p.selling_price),expiry:expiryDate,leadTimeDays:Number(p.lead_time_days)};
      await client.query("INSERT INTO recycle_bin(id,shop_id,product_id,product_snapshot,stock_at_expiry,expiry_date,reason) VALUES($1,$2,$3,$4::jsonb,$5,$6,'Expiry date passed')",[recycleId,p.shop_id,p.id,JSON.stringify(snapshot),p.stock,expiryDate]);
      await client.query("UPDATE products SET is_active=FALSE,stock=0,updated_at=NOW() WHERE id=$1",[p.id]);
      await recordMovement(client,{shopId:p.shop_id,productId:p.id,type:"expiry",delta:-Number(p.stock),balanceAfter:0,unitCost:Number(p.unit_cost),reason:"Expiry date passed; moved to recycle bin",referenceType:"recycle_bin",referenceId:recycleId});
      await client.query("INSERT INTO notifications(id,shop_id,kind,title,message,payload) VALUES($1,$2,'product_expired','Expired product moved to recycle bin',$3,$4::jsonb)",[id(),p.shop_id,p.name+" expired on "+expiryDate+" and was moved out of active inventory.",JSON.stringify({productId:p.id,recycleBinId:recycleId,expiryDate})]);
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
app.use("/api",asyncRoute(async(req,res,next)=>{if(/^\/(?:qr-tokens\/[^/]+\/status|demo-product-qr(?:\/[^/]+\/status|\/consume-preview)?|customer\/catalog\/)/.test(req.path))return next();try{await runExpirySweep();}catch(err){console.error("Expiry sweep failed:",err.message);}next();}));

app.get("/healthz",asyncRoute(async(_req,res)=>{await pool.query("SELECT 1");res.json({ok:true,service:"easy-gateway",database:"connected",time:new Date().toISOString()});}));

app.get("/scan/:token",asyncRoute(async(req,res)=>{
  res.set("Cache-Control","no-store, max-age=0");
  const token=text(req.params.token);
  if(!/^[A-Za-z0-9_-]{43}$/.test(token))return res.status(410).type("html").send(qrScanPage(null));
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const claimed=await client.query("UPDATE product_qr_tokens q SET consumed_at=NOW() WHERE q.token_hash=$1 AND q.consumed_at IS NULL AND q.expires_at>NOW() AND EXISTS(SELECT 1 FROM products p WHERE p.id=q.product_id AND p.shop_id=q.shop_id AND p.is_active=TRUE) RETURNING q.shop_id,q.product_id",[hashQrToken(token)]);
    if(!claimed.rowCount){await client.query("ROLLBACK");return res.status(410).type("html").send(qrScanPage(null));}
    const product=await client.query("SELECT s.name AS shop_name,p.name,p.sku,p.category,p.unit,p.stock,p.selling_price,p.expiry_date::text AS expiry_date FROM products p JOIN shops s ON s.id=p.shop_id WHERE p.id=$1 AND p.shop_id=$2 AND p.is_active=TRUE",[claimed.rows[0].product_id,claimed.rows[0].shop_id]);
    if(!product.rowCount){await client.query("ROLLBACK");return res.status(410).type("html").send(qrScanPage(null));}
    await client.query("COMMIT");
    return res.type("html").send(qrScanPage(qrProductDetails(product.rows[0])));
  }catch(err){await client.query("ROLLBACK").catch(()=>{});throw err;}
  finally{client.release();}
}));
app.get("/retail-core.js",(_req,res)=>res.type("application/javascript").set("Cache-Control","no-cache").sendFile(path.join(__dirname,"lib","retail-core.js")));
app.get("/app-features.js",(_req,res)=>res.type("application/javascript").set("Cache-Control","no-cache").sendFile(path.join(__dirname,"app-features.js")));
app.get("/shop/:slug",(_req,res)=>res.sendFile(path.join(__dirname,"index.html")));
app.get("/",(_req,res)=>res.sendFile(path.join(__dirname,"index.html")));
app.get("/favicon.ico",(_req,res)=>res.status(204).end());

app.post("/api/auth/register",authLimiter,asyncRoute(async(req,res)=>{
  const fullName=text(req.body.fullName),shopName=text(req.body.shopName),email=text(req.body.email).toLowerCase(),password=typeof req.body.password==="string"?req.body.password:"";
  if(fullName.length<2||fullName.length>100)throw fail(400,"Enter your full name (2–100 characters).");
  if(shopName.length<2||shopName.length>120)throw fail(400,"Enter your shop name (2–120 characters).");
  if(!emailPattern.test(email)||email.length>254)throw fail(400,"Enter a valid email address.");
  if(password.length<10||password.length>128)throw fail(400,"Choose a password between 10 and 128 characters.");
  const passwordHash=await bcrypt.hash(password,12),client=await pool.connect(),shopId=id(),userId=id();let publicSlug="";
  try{
    await client.query("BEGIN");
    if((await client.query("SELECT 1 FROM users WHERE email=$1",[email])).rowCount)throw fail(409,"An account already exists for this email. Sign in instead.");
    await client.query("INSERT INTO shops(id,name) VALUES($1,$2)",[shopId,shopName]);
    await client.query("INSERT INTO users(id,shop_id,full_name,email,password_hash,role) VALUES($1,$2,$3,$4,$5,'owner')",[userId,shopId,fullName,email,passwordHash]);
    await client.query("INSERT INTO shop_settings(shop_id) VALUES($1)",[shopId]);
    publicSlug=(await client.query("SELECT public_slug FROM shops WHERE id=$1",[shopId])).rows[0].public_slug;
    await client.query("COMMIT");
  }catch(err){await client.query("ROLLBACK").catch(()=>{});if(err.code==="23505")throw fail(409,"An account with this email already exists.");throw err;}
  finally{client.release();}
  await regenerateSession(req);req.session.user={id:userId,shopId,name:fullName,email,role:"owner",shopName,publicSlug};await saveSession(req);
  res.status(201).json({user:publicUser(req.session.user)});
}));
app.post("/api/auth/login",authLimiter,asyncRoute(async(req,res)=>{
  const email=text(req.body.email).toLowerCase(),password=typeof req.body.password==="string"?req.body.password:"";
  if(!emailPattern.test(email)||!password)throw fail(400,"Enter your email and password.");
  const result=await pool.query("SELECT u.id,u.shop_id,u.full_name,u.email,u.password_hash,u.role,s.name AS shop_name,s.public_slug FROM users u JOIN shops s ON s.id=u.shop_id WHERE u.email=$1",[email]);
  if(!result.rowCount||!(await bcrypt.compare(password,result.rows[0].password_hash)))throw fail(401,"Email or password is incorrect.");
  const row=result.rows[0];await regenerateSession(req);
  req.session.user={id:row.id,shopId:row.shop_id,name:row.full_name,email:row.email,role:row.role,shopName:row.shop_name,publicSlug:row.public_slug};
  await saveSession(req);res.json({user:publicUser(req.session.user)});
}));
app.get("/api/auth/me",(req,res)=>{if(!req.session||!req.session.user)return res.status(401).json({error:"Please sign in.",code:"AUTH_REQUIRED"});res.json({user:publicUser(req.session.user)});});
app.post("/api/auth/logout",asyncRoute(async(req,res)=>{if(req.session)await new Promise(resolve=>req.session.destroy(()=>resolve()));res.clearCookie("easy_gateway.sid",{httpOnly:true,sameSite:"lax",secure:NODE_ENV==="production"});res.json({ok:true});}));

async function calculateDashboard(shopId){
  const setting=await pool.query("SELECT timezone FROM shop_settings WHERE shop_id=$1",[shopId]);
  const tz=setting.rows[0]?.timezone||"Asia/Kolkata";
  const localToday="(NOW() AT TIME ZONE $2::text)::date";
  const todayStart="(("+localToday+")::timestamp AT TIME ZONE $2::text)";
  const yesterdayStart="((("+localToday+") - 1)::timestamp AT TIME ZONE $2::text)";
  const seriesStart="((("+localToday+") - days.n)::timestamp AT TIME ZONE $2::text)";
  const seriesEnd="((("+localToday+") - days.n + 1)::timestamp AT TIME ZONE $2::text)";
  const [stats,dailyRows,lowRows]=await Promise.all([
    pool.query("SELECT COALESCE(SUM(total) FILTER(WHERE created_at>="+todayStart+"),0) AS revenue_today,COUNT(DISTINCT COALESCE(sale_group_id,id)) FILTER(WHERE created_at>="+todayStart+")::int AS orders_today,COALESCE(SUM(total) FILTER(WHERE created_at>="+yesterdayStart+" AND created_at<"+todayStart+"),0) AS revenue_yesterday,(SELECT COUNT(*)::int FROM products WHERE shop_id=$1 AND is_active=TRUE AND stock<=reorder_at) AS low_stock,(SELECT COUNT(*)::int FROM products WHERE shop_id=$1 AND is_active=TRUE) AS product_count,(SELECT COALESCE(SUM(coin_balance),0)::bigint FROM customers WHERE shop_id=$1) AS loyalty_coins FROM sales WHERE shop_id=$1",[shopId,tz]),
    pool.query("SELECT TO_CHAR((NOW() AT TIME ZONE $2::text)::date-days.n,'YYYY-MM-DD') AS day,COALESCE(SUM(s.total),0)::numeric(14,2) AS revenue,COUNT(DISTINCT COALESCE(s.sale_group_id,s.id))::int AS order_count FROM generate_series(6,0,-1) AS days(n) LEFT JOIN sales s ON s.shop_id=$1 AND s.created_at>="+seriesStart+" AND s.created_at<"+seriesEnd+" GROUP BY days.n ORDER BY days.n DESC",[shopId,tz]),
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
app.get("/api/action-center",requireAuth,asyncRoute(async(req,res)=>{
  const shopId=req.user.shopId;
  const tz=(await pool.query("SELECT timezone FROM shop_settings WHERE shop_id=$1",[shopId])).rows[0]?.timezone||"Asia/Kolkata";
  const r=await pool.query("SELECT p.*,COALESCE(SUM(s.quantity) FILTER (WHERE s.created_at>=NOW()-INTERVAL '30 days'),0) AS sold_30d,CASE WHEN p.expiry_date IS NULL THEN NULL ELSE (p.expiry_date-((NOW() AT TIME ZONE $2::text)::date)) END AS days_to_expiry,GREATEST(0,((NOW() AT TIME ZONE $2::text)::date-p.created_at::date)) AS age_days FROM products p LEFT JOIN sales s ON s.product_id=p.id AND s.shop_id=p.shop_id WHERE p.shop_id=$1 AND p.is_active=TRUE GROUP BY p.id ORDER BY p.name",[shopId,tz]);
  const products=r.rows.map(p=>({id:p.id,name:p.name,sku:p.sku,barcode:p.barcode,category:p.category,unit:p.unit,stock:Number(p.stock),reorderAt:Number(p.reorder_at),cost:Number(p.unit_cost),price:Number(p.selling_price),expiry:dateOnly(p.expiry_date),daysToExpiry:p.days_to_expiry==null?null:Number(p.days_to_expiry),ageDays:Number(p.age_days),soldLast30Days:Number(p.sold_30d)}));
  res.json({...buildStockActions(products),generatedAt:new Date().toISOString()});
}));
app.get("/api/daily-summary",requireAuth,asyncRoute(async(req,res)=>{
  const shopId=req.user.shopId,requested=text(req.query.date);
  if(requested&&(!datePattern.test(requested)||!validDate(requested)))throw fail(400,"Enter a valid summary date.");
  const settings=await pool.query("SELECT st.timezone,st.currency,sh.name AS shop_name FROM shop_settings st JOIN shops sh ON sh.id=st.shop_id WHERE st.shop_id=$1",[shopId]);
  const tz=settings.rows[0]?.timezone||"Asia/Kolkata",currency=settings.rows[0]?.currency||"INR",shopName=settings.rows[0]?.shop_name||"My shop";
  let day=requested;
  if(!day)day=(await pool.query("SELECT TO_CHAR((NOW() AT TIME ZONE $1::text)::date,'YYYY-MM-DD') AS day",[tz])).rows[0].day;
  const bounds="created_at>=(($2::date)::timestamp AT TIME ZONE $3) AND created_at<((($2::date)+1)::timestamp AT TIME ZONE $3)";
  const [stats,top,newCustomers,low,expiring]=await Promise.all([
    pool.query("SELECT COALESCE(SUM(total),0) AS revenue,COALESCE(SUM(quantity),0) AS items,COALESCE(SUM(coins_earned),0) AS coins,COUNT(DISTINCT COALESCE(sale_group_id,id))::int AS orders FROM sales WHERE shop_id=$1 AND "+bounds,[shopId,day,tz]),
    pool.query("SELECT product_name,COALESCE(SUM(quantity),0) AS quantity,COALESCE(SUM(total),0) AS revenue FROM sales WHERE shop_id=$1 AND "+bounds+" GROUP BY product_name ORDER BY revenue DESC,quantity DESC LIMIT 5",[shopId,day,tz]),
    pool.query("SELECT COUNT(*)::int AS count FROM customers WHERE shop_id=$1 AND created_at>=(($2::date)::timestamp AT TIME ZONE $3) AND created_at<((($2::date)+1)::timestamp AT TIME ZONE $3)",[shopId,day,tz]),
    pool.query("SELECT COUNT(*)::int AS count FROM products WHERE shop_id=$1 AND is_active=TRUE AND stock<=reorder_at",[shopId]),
    pool.query("SELECT COUNT(*)::int AS count FROM products WHERE shop_id=$1 AND is_active=TRUE AND expiry_date IS NOT NULL AND expiry_date BETWEEN (NOW() AT TIME ZONE $2::text)::date AND (NOW() AT TIME ZONE $2::text)::date+7",[shopId,tz])
  ]);
  const revenue=Number(stats.rows[0].revenue),orders=Number(stats.rows[0].orders);
  const summary={date:day,shopName,currency,revenue,orders,itemsSold:Number(stats.rows[0].items),averageOrder:orders?Math.round(revenue/orders*100)/100:0,coinsAwarded:Number(stats.rows[0].coins),newCustomers:Number(newCustomers.rows[0].count),topProducts:top.rows.map(x=>({name:x.product_name,quantity:Number(x.quantity),revenue:Number(x.revenue)})),lowStockCount:Number(low.rows[0].count),expiringSoonCount:Number(expiring.rows[0].count),generatedAt:new Date().toISOString()};
  summary.shareText=buildSummaryText(summary);
  res.json({summary});
}));
app.get("/api/bootstrap",requireAuth,asyncRoute(async(req,res)=>{
  const shopId=req.user.shopId;
  const [settings,products,sales,customers,suppliers,bin,notifications,orders,customerOrders,dashboard,shopMeta,redemptions,receipts]=await Promise.all([
    getShopSettings(shopId),
    pool.query("SELECT * FROM products WHERE shop_id=$1 AND is_active=TRUE ORDER BY name",[shopId]),
    pool.query("SELECT * FROM sales WHERE shop_id=$1 ORDER BY created_at DESC LIMIT 100",[shopId]),
    pool.query("SELECT * FROM customers WHERE shop_id=$1 ORDER BY coin_balance DESC,name",[shopId]),
    pool.query("SELECT * FROM suppliers WHERE shop_id=$1 AND is_active=TRUE ORDER BY name",[shopId]),
    pool.query("SELECT * FROM recycle_bin WHERE shop_id=$1 AND restored_at IS NULL AND deleted_at IS NULL ORDER BY recycled_at DESC",[shopId]),
    pool.query("SELECT * FROM notifications WHERE shop_id=$1 ORDER BY created_at DESC LIMIT 100",[shopId]),
    pool.query("SELECT po.*,sp.name AS supplier_name,(SELECT COUNT(*)::int FROM purchase_order_items i WHERE i.purchase_order_id=po.id) AS item_count FROM purchase_orders po LEFT JOIN suppliers sp ON sp.id=po.supplier_id WHERE po.shop_id=$1 ORDER BY po.created_at DESC LIMIT 100",[shopId]),
    pool.query("SELECT * FROM customer_orders WHERE shop_id=$1 ORDER BY created_at DESC LIMIT 200",[shopId]),
    calculateDashboard(shopId),
    pool.query("SELECT public_slug FROM shops WHERE id=$1",[shopId]),
    pool.query("SELECT r.*,c.name AS customer_name FROM loyalty_redemptions r JOIN customers c ON c.id=r.customer_id WHERE r.shop_id=$1 ORDER BY r.created_at DESC LIMIT 100",[shopId]),
    pool.query("SELECT r.*,(SELECT COUNT(*)::int FROM stock_receipt_items i WHERE i.stock_receipt_id=r.id) AS item_count,(SELECT COALESCE(SUM(i.quantity*i.unit_cost),0)::numeric(14,2) FROM stock_receipt_items i WHERE i.stock_receipt_id=r.id) AS total_cost FROM stock_receipts r WHERE r.shop_id=$1 ORDER BY r.created_at DESC LIMIT 100",[shopId])
  ]);
  res.json({
    user:{...publicUser(req.user),publicSlug:shopMeta.rows[0]?.public_slug||req.user.publicSlug||""},settings,
    products:products.rows.map(productDto),sales:sales.rows.map(saleDto),customers:customers.rows.map(customerDto),suppliers:suppliers.rows.map(supplierDto),
    recycleBin:bin.rows.map(r=>({id:r.id,productId:r.product_id,product:r.product_snapshot,stockAtExpiry:Number(r.stock_at_expiry),expiry:dateOnly(r.expiry_date),reason:r.reason,recycledAt:r.recycled_at,recordedQuantity:r.recorded_quantity==null?null:Number(r.recorded_quantity),recordedLoss:r.recorded_loss==null?null:Number(r.recorded_loss),wasteMethod:r.waste_method||"",wasteNote:r.waste_note||"",wasteRecordedAt:r.waste_recorded_at||null})),
    notifications:notifications.rows.map(notificationDto),
    purchaseOrders:orders.rows.map(r=>({id:r.id,supplierId:r.supplier_id,supplierName:r.supplier_name||"Not assigned",status:r.status,source:r.source,totalCost:Number(r.total_cost),itemCount:Number(r.item_count),createdAt:r.created_at})),
    customerOrders:customerOrders.rows.map(customerOrderDto),
    loyaltyRedemptions:redemptions.rows.map(x=>({id:x.id,customerId:x.customer_id,customerName:x.customer_name,rewardCode:x.reward_code,rewardLabel:x.reward_label,coinsSpent:Number(x.coins_spent),rewardValue:Number(x.reward_value),status:x.status,voucherCode:x.voucher_code,createdAt:x.created_at})),
    stockReceipts:receipts.rows.map(x=>({id:x.id,reference:x.reference,note:x.note,supplierId:x.supplier_id,itemCount:Number(x.item_count),totalCost:Number(x.total_cost),createdAt:x.created_at})),
    dashboard
  });
}));

app.get("/api/products",requireAuth,asyncRoute(async(req,res)=>{
  const q=text(req.query.q),pattern="%"+q.replace(/[%_\\]/g,"\\$&")+"%";
  const r=await pool.query("SELECT * FROM products WHERE shop_id=$1 AND is_active=TRUE AND ($2='' OR name ILIKE $3 OR sku ILIKE $3 OR barcode ILIKE $3 OR category ILIKE $3) ORDER BY name",[req.user.shopId,q,pattern]);
  res.json({products:r.rows.map(productDto)});
}));
app.get("/api/products/lookup",requireAuth,asyncRoute(async(req,res)=>{
  const code=text(req.query.code);
  if(!code||code.length>100)throw fail(400,"Enter a barcode or SKU to look up.");
  const normalized=normalizeCode(code);
  const r=await pool.query("SELECT p.*,(p.barcode<>'' AND LOWER(p.barcode)=LOWER($2)) AS barcode_match FROM products p WHERE p.shop_id=$1 AND p.is_active=TRUE AND (LOWER(p.barcode)=LOWER($2) OR LOWER(p.sku)=LOWER($2) OR EXISTS(SELECT 1 FROM product_identifiers i WHERE i.product_id=p.id AND i.shop_id=p.shop_id AND i.retired_at IS NULL AND i.normalized_value=$3) OR EXISTS(SELECT 1 FROM serialized_units u WHERE u.product_id=p.id AND u.shop_id=p.shop_id AND u.normalized_serial=$3 AND u.status='in_stock')) ORDER BY barcode_match DESC,name LIMIT 1",[req.user.shopId,code,normalized]);
  if(!r.rowCount)throw fail(404,"No active product matches the code \""+code+"\". Add it in Inventory first.");
  let unit=null;
  const serial=await pool.query("SELECT serial FROM serialized_units WHERE shop_id=$1 AND product_id=$2 AND normalized_serial=$3 AND status='in_stock' LIMIT 1",[req.user.shopId,r.rows[0].id,normalized]);
  if(serial.rowCount)unit=serial.rows[0].serial;
  res.json({product:productDto(r.rows[0]),serialUnit:unit});
}));
app.post("/api/products",requireAuth,asyncRoute(async(req,res)=>{
  const name=text(req.body.name),sku=text(req.body.sku)||"EG-"+crypto.randomBytes(4).toString("hex").toUpperCase(),barcode=text(req.body.barcode),category=text(req.body.category)||"General retail",unit=text(req.body.unit)||"piece",trackSerials=req.body.trackSerials===true;
  const stock=Number(req.body.stock??0),reorderAt=Number(req.body.reorderAt??0),cost=Number(req.body.cost??0),price=Number(req.body.price??0),lead=Number(req.body.leadTimeDays??3),expiry=text(req.body.expiry)||null;
  if(!name||name.length>180||sku.length>100||barcode.length>100||category.length>100||unit.length>60)throw fail(400,"Product name is required; SKU, barcode, category and unit limits were exceeded.");
  if(![stock,reorderAt,cost,price,lead].every(Number.isFinite)||[stock,reorderAt,cost,price].some(v=>v<0)||!Number.isInteger(lead)||lead<0||lead>180)throw fail(400,"Enter valid non-negative inventory and price values.");
  if(trackSerials&&(!Number.isInteger(stock)||stock!==0))throw fail(400,"Serialized products must start with zero stock. Receive each unit with its serial number in Stocking mode.");
  if(expiry&&(!datePattern.test(expiry)||!validDate(expiry)))throw fail(400,"Enter a valid expiry date.");
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const productId=id();
    const r=await client.query("INSERT INTO products(id,shop_id,name,sku,barcode,category,unit,stock,reorder_at,unit_cost,selling_price,lead_time_days,expiry_date,track_serials) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *",[productId,req.user.shopId,name,sku,barcode,category,unit,stock,reorderAt,cost,price,lead,expiry,trackSerials]);
    await syncProductIdentifiers(client,req.user.shopId,r.rows[0],req.user.id);
    if(stock>0)await recordMovement(client,{shopId:req.user.shopId,productId,type:"adjustment",delta:stock,balanceAfter:stock,unitCost:cost,reason:"Opening stock entered with product",referenceType:"product",referenceId:productId,actorId:req.user.id});
    await client.query("COMMIT");
    await runExpirySweep();
    const active=await pool.query("SELECT * FROM products WHERE id=$1 AND shop_id=$2 AND is_active=TRUE",[productId,req.user.shopId]);
    if(!active.rowCount)return res.status(201).json({recycledImmediately:true,message:"The expiry date has passed; the item was moved to the recycle bin."});
    res.status(201).json({product:productDto(active.rows[0])});
  }catch(err){await client.query("ROLLBACK").catch(()=>{});if(err.code==="23505")throw fail(409,"That SKU or barcode already exists in this shop.");throw err;}
  finally{client.release();}
}));
app.delete("/api/products/:id/demo",requireAuth,asyncRoute(async(req,res)=>{
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const removed=await client.query("DELETE FROM products WHERE id=$1 AND shop_id=$2 AND is_demo=TRUE RETURNING name",[req.params.id,req.user.shopId]);
    if(!removed.rowCount)throw fail(404,"QR sample not found. Only products imported from a sample QR can be removed this way.");
    await notify(req.user.shopId,"demo_product_removed","QR sample removed",removed.rows[0].name+" was removed after the demonstration.",{productId:req.params.id},client);
    await client.query("COMMIT");
    res.json({ok:true,name:removed.rows[0].name});
  }catch(err){await client.query("ROLLBACK").catch(()=>{});throw err;}
  finally{client.release();}
}));
app.put("/api/products/:id",requireAuth,asyncRoute(async(req,res)=>{
  const x={name:text(req.body.name),sku:text(req.body.sku),barcode:text(req.body.barcode),category:text(req.body.category)||"General retail",unit:text(req.body.unit)||"piece",stock:Number(req.body.stock),reorderAt:Number(req.body.reorderAt),cost:Number(req.body.cost),price:Number(req.body.price),lead:Number(req.body.leadTimeDays??3),expiry:text(req.body.expiry)||null,trackSerials:req.body.trackSerials===true,reason:text(req.body.reason)};
  if(!x.name||x.name.length>180||!x.sku||x.sku.length>100||x.barcode.length>100||x.category.length>100||x.unit.length>60||![x.stock,x.reorderAt,x.cost,x.price,x.lead].every(Number.isFinite)||[x.stock,x.reorderAt,x.cost,x.price].some(v=>v<0)||!Number.isInteger(x.lead)||x.lead<0||x.lead>180||(x.expiry&&(!datePattern.test(x.expiry)||!validDate(x.expiry))))throw fail(400,"Product details are invalid.");
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const current=await client.query("SELECT * FROM products WHERE id=$1 AND shop_id=$2 AND is_active=TRUE FOR UPDATE",[req.params.id,req.user.shopId]);
    if(!current.rowCount)throw fail(404,"Product not found.");
    const before=Number(current.rows[0].stock),delta=Math.round((x.stock-before)*1000)/1000;
    if(delta!==0&&(x.reason.length<3||x.reason.length>240))throw fail(400,"Stock changed. Enter a reason (3–240 characters) so the adjustment is audited, or use Stocking mode.");
    if(delta!==0&&x.trackSerials&&!current.rows[0].track_serials)throw fail(400,"Turn on serial tracking through Stocking mode so each unit can receive a serial number.");
    if(x.trackSerials&&!current.rows[0].track_serials&&before>0)throw fail(400,"Serial tracking can only be turned on for a product with zero stock. Receive serialized units in Stocking mode instead.");
    let r;
    try{
      r=await client.query("UPDATE products SET name=$3,sku=$4,barcode=$5,category=$6,unit=$7,stock=$8,reorder_at=$9,unit_cost=$10,selling_price=$11,lead_time_days=$12,expiry_date=$13,track_serials=$14,updated_at=NOW() WHERE id=$1 AND shop_id=$2 RETURNING *",[req.params.id,req.user.shopId,x.name,x.sku,x.barcode,x.category,x.unit,x.stock,x.reorderAt,x.cost,x.price,x.lead,x.expiry,x.trackSerials]);
    }catch(err){if(err.code==="23505")throw fail(409,"That SKU or barcode already exists in this shop.");throw err;}
    await syncProductIdentifiers(client,req.user.shopId,r.rows[0],req.user.id);
    if(delta!==0)await recordMovement(client,{shopId:req.user.shopId,productId:r.rows[0].id,type:"adjustment",delta,balanceAfter:x.stock,unitCost:x.cost,reason:x.reason,referenceType:"product_edit",referenceId:r.rows[0].id,actorId:req.user.id});
    await client.query("COMMIT");
  }catch(err){await client.query("ROLLBACK").catch(()=>{});throw err;}
  finally{client.release();}
  await runExpirySweep();
  const active=await pool.query("SELECT * FROM products WHERE id=$1 AND shop_id=$2 AND is_active=TRUE",[req.params.id,req.user.shopId]);
  res.json(active.rowCount?{product:productDto(active.rows[0])}:{recycledImmediately:true,message:"Product expired and was moved to the recycle bin."});
}));
app.post("/api/products/:id/stock-adjustments",requireAuth,asyncRoute(async(req,res)=>{
  const delta=Number(req.body.delta),reason=text(req.body.reason);
  if(!Number.isFinite(delta)||delta===0||Math.abs(delta)>1000000||reason.length<3||reason.length>240)throw fail(400,"Enter a non-zero adjustment and a reason (3–240 characters).");
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const current=await client.query("SELECT * FROM products WHERE id=$1 AND shop_id=$2 AND is_active=TRUE FOR UPDATE",[req.params.id,req.user.shopId]);
    if(!current.rowCount)throw fail(404,"Product not found.");
    if(current.rows[0].track_serials)throw fail(409,"This product tracks serial numbers. Receive or return serialized units through Stocking mode instead of a blind quantity adjustment.");
    const r=await client.query("UPDATE products SET stock=stock+$3,updated_at=NOW() WHERE id=$1 AND shop_id=$2 AND is_active=TRUE AND stock+$3>=0 RETURNING *",[req.params.id,req.user.shopId,delta]);
    if(!r.rowCount)throw fail(409,"Product not found or adjustment would make stock negative.");
    await recordMovement(client,{shopId:req.user.shopId,productId:req.params.id,type:"adjustment",delta,balanceAfter:Number(r.rows[0].stock),unitCost:Number(r.rows[0].unit_cost),reason,referenceType:"stock_adjustment",actorId:req.user.id});
    await notify(req.user.shopId,"stock_adjustment","Inventory adjusted",r.rows[0].name+": "+(delta>0?"+":"")+delta+". Reason: "+reason,{productId:req.params.id,delta,reason,userId:req.user.id},client);
    await client.query("COMMIT");
    res.json({product:productDto(r.rows[0])});
  }catch(err){await client.query("ROLLBACK").catch(()=>{});throw err;}
  finally{client.release();}
}));

app.post("/api/stock/receipts",requireAuth,asyncRoute(async(req,res)=>{
  const requested=Array.isArray(req.body.items)?req.body.items:[];
  const reference=text(req.body.reference),note=text(req.body.note),supplierId=text(req.body.supplierId)||null;
  if(!requested.length||requested.length>100)throw fail(400,"A stock receipt must contain between 1 and 100 product lines.");
  if(reference.length>80||note.length>500)throw fail(400,"Receipt reference must be 80 characters or fewer and the note 500 characters or fewer.");
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const replay=await readIdempotentReplay(req,client,"POST /api/stock/receipts");
    if(replay){await client.query("COMMIT");return res.status(replay.statusCode).json(replay.body);}
    if(supplierId&&!((await client.query("SELECT id FROM suppliers WHERE id=$1 AND shop_id=$2 AND is_active=TRUE",[supplierId,req.user.shopId])).rowCount))throw fail(400,"The selected supplier is not available in this shop.");
    const tz=(await client.query("SELECT timezone FROM shop_settings WHERE shop_id=$1",[req.user.shopId])).rows[0]?.timezone||"Asia/Kolkata";
    const today=(await client.query("SELECT (NOW() AT TIME ZONE $1)::date AS day",[tz])).rows[0].day;
    const lines=[],seenSerials=new Map();
    for(const item of requested){
      const productId=text(item&&item.productId),code=text(item&&item.code),quantity=Number(item&&item.quantity),serials=parseSerialList(item&&item.serials);
      const unitCost=item&&item.unitCost!=null&&item.unitCost!==""?Number(item.unitCost):null;
      const expiry=text(item&&item.expiry)||null;
      if(!Number.isFinite(quantity)||quantity<=0||quantity>1000000)throw fail(400,"Every stock line needs a positive quantity.");
      if(unitCost!==null&&(!Number.isFinite(unitCost)||unitCost<0))throw fail(400,"Unit cost must be a non-negative number.");
      if(expiry&&(!datePattern.test(expiry)||!validDate(expiry)))throw fail(400,"Enter a valid expiry date for the received stock.");
      if(expiry&&isBeforeDate(expiry,today))throw fail(400,"Received stock cannot already be expired. Correct the expiry date or record it through the expiry process.");
      if(!productId&&!code)throw fail(400,"Each stock line needs a product or a scanned code.");
      for(const serial of serials){
        const normalized=normalizeCode(serial);
        if(seenSerials.has(normalized))throw fail(409,"Serial \""+serial+"\" appears more than once in this receipt.");
        seenSerials.set(normalized,serial);
      }
      lines.push({productId:productId||null,code,quantity,unitCost,expiry,serials});
    }
    const found=[];
    for(const line of lines){
      const productId=line.productId||(await client.query("SELECT p.id FROM products p WHERE p.shop_id=$1 AND p.is_active=TRUE AND (LOWER(p.barcode)=LOWER($2) OR LOWER(p.sku)=LOWER($2) OR EXISTS(SELECT 1 FROM product_identifiers i WHERE i.product_id=p.id AND i.shop_id=p.shop_id AND i.retired_at IS NULL AND i.normalized_value=$3)) ORDER BY (LOWER(p.barcode)=LOWER($2)) DESC,name LIMIT 1",[req.user.shopId,line.code,normalizeCode(line.code)])).rows[0]?.id;
      if(!productId)throw fail(404,"No active product matches \""+line.code+"\". Add it in Inventory first.");
      const product=await client.query("SELECT * FROM products WHERE id=$1 AND shop_id=$2 AND is_active=TRUE FOR UPDATE",[productId,req.user.shopId]);
      if(!product.rowCount)throw fail(404,"One product in this receipt is not active in this shop.");
      found.push({...line,productId,product:product.rows[0]});
    }
    const groupedSerials=[];
    for(const line of found){
      const p=line.product;
      if(p.track_serials){
        if(!Number.isInteger(line.quantity))throw fail(409,p.name+" tracks serial numbers, so the received quantity must be a whole number.");
        if(line.serials.length!==line.quantity)throw fail(409,"Enter exactly "+line.quantity+" serial number"+(line.quantity===1?"":"s")+" for "+p.name+".");
        const normalized=line.serials.map(normalizeCode);
        const existing=await client.query("SELECT normalized_serial FROM serialized_units WHERE shop_id=$1 AND normalized_serial=ANY($2::text[])",[req.user.shopId,normalized]);
        if(existing.rowCount){
          const used=new Set(existing.rows.map(r=>r.normalized_serial));
          const duplicate=line.serials.filter(s=>used.has(normalizeCode(s)));
          throw fail(409,"These serial numbers are already recorded in this shop: "+duplicate.join(", ")+".");
        }
        groupedSerials.push(...normalized.map((serial,index)=>({productId:p.id,serial:line.serials[index],normalized:serial})));
      }else if(line.serials.length){
        throw fail(400,p.name+" does not track individual serial numbers. Remove the serial values and receive by quantity.");
      }
    }
    const body=await withIdempotency(req,client,"POST /api/stock/receipts",async()=>{
      const receiptId=id();
      await client.query("INSERT INTO stock_receipts(id,shop_id,supplier_id,reference,note,received_by) VALUES($1,$2,$3,$4,$5,$6)",[receiptId,req.user.shopId,supplierId,reference,note,req.user.id]);
      const items=[];
      let totalCost=0;
      for(const line of found){
        const updated=await client.query("UPDATE products SET stock=stock+$3,unit_cost=CASE WHEN $4::numeric IS NULL THEN unit_cost ELSE $4::numeric END,expiry_date=CASE WHEN $5::date IS NULL THEN expiry_date ELSE $5::date END,updated_at=NOW() WHERE id=$1 AND shop_id=$2 AND is_active=TRUE RETURNING *",[line.productId,req.user.shopId,line.quantity,line.unitCost,line.expiry]);
        if(!updated.rowCount)throw fail(409,"One product changed or expired while the receipt was being saved. Refresh and try again.");
        const p=updated.rows[0],cost=line.unitCost===null?Number(p.unit_cost):line.unitCost,lineCost=Math.round(cost*line.quantity*100)/100;
        totalCost+=lineCost;
        await client.query("INSERT INTO stock_receipt_items(id,stock_receipt_id,product_id,product_name,quantity,unit_cost,expiry_date,serials) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)",[id(),receiptId,p.id,p.name,line.quantity,cost,line.expiry||dateOnly(p.expiry_date)||null,JSON.stringify(line.serials)]);
        if(p.track_serials){
          for(const serial of line.serials){
            await client.query("INSERT INTO serialized_units(id,shop_id,product_id,serial,normalized_serial,status,stock_receipt_id) VALUES($1,$2,$3,$4,$5,'in_stock',$6)",[id(),req.user.shopId,p.id,serial,normalizeCode(serial),receiptId]);
          }
        }
        await recordMovement(client,{shopId:req.user.shopId,productId:p.id,type:"stock_receipt",delta:line.quantity,balanceAfter:Number(p.stock),unitCost:cost,reason:reference?("Stock received · "+reference):"Stock received in Stocking mode",referenceType:"stock_receipt",referenceId:receiptId,actorId:req.user.id});
        items.push({productId:p.id,name:p.name,quantity:line.quantity,unitCost:cost,expiry:line.expiry||dateOnly(p.expiry_date)||"",serials:line.serials,balanceAfter:Number(p.stock)});
      }
      await notify(req.user.shopId,"stock_receipt","Stock received",items.length+" product line"+(items.length===1?"":"s")+" received"+(reference?" · "+reference:"")+".",{receiptId,totalCost:Math.round(totalCost*100)/100},client);
      return {receipt:{id:receiptId,reference,note,supplierId,itemCount:items.length,totalCost:Math.round(totalCost*100)/100,createdAt:new Date().toISOString()},items};
    },201);
    await client.query("COMMIT");
    res.status(body.statusCode||201).json(body.body);
  }catch(err){await client.query("ROLLBACK").catch(()=>{});if(err.code==="23505")throw fail(409,"A serial number in this receipt is already recorded in this shop.");throw err;}
  finally{client.release();}
}));

app.get("/api/loyalty/rewards",requireAuth,asyncRoute(async(_req,res)=>{
  res.json({rewards:LOYALTY_REWARDS});
}));
app.post("/api/loyalty/redeem",requireAuth,asyncRoute(async(req,res)=>{
  const customerId=text(req.body.customerId),reward=rewardFor(req.body.rewardCode);
  if(!customerId)throw fail(400,"Choose the customer who is redeeming coins.");
  if(!reward)throw fail(400,"Choose a valid loyalty reward.");
  if(!validEmail(req.user.email))throw fail(400,"This account needs a valid email before vouchers can be issued.");
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const replay=await readIdempotentReplay(req,client,"POST /api/loyalty/redeem");
    if(replay){await client.query("COMMIT");return res.status(replay.statusCode).json(replay.body);}
    const customer=await client.query("SELECT * FROM customers WHERE id=$1 AND shop_id=$2 FOR UPDATE",[customerId,req.user.shopId]);
    if(!customer.rowCount)throw fail(404,"Customer not found in this shop.");
    if(Number(customer.rows[0].coin_balance)<reward.coins)throw fail(409,"This customer has "+Number(customer.rows[0].coin_balance)+" coins. "+reward.label+" needs "+reward.coins+" coins.");
    const body=await withIdempotency(req,client,"POST /api/loyalty/redeem",async()=>{
      const updated=await client.query("UPDATE customers SET coin_balance=coin_balance-$3 WHERE id=$1 AND shop_id=$2 AND coin_balance>=$3 RETURNING *",[customerId,req.user.shopId,reward.coins]);
      if(!updated.rowCount)throw fail(409,"The customer's coin balance changed before the reward could be issued. Refresh and try again.");
      await client.query("INSERT INTO loyalty_transactions(id,shop_id,customer_id,delta,reason) VALUES($1,$2,$3,$4,$5)",[id(),req.user.shopId,customerId,-reward.coins,"Reward redemption: "+reward.code]);
      let voucher="";
      for(let attempt=0;attempt<5&&!voucher;attempt++){
        const candidate=voucherCode();
        try{
          await client.query("INSERT INTO loyalty_redemptions(id,shop_id,customer_id,reward_code,reward_label,coins_spent,reward_value,status,voucher_code,created_by,idempotency_key) VALUES($1,$2,$3,$4,$5,$6,$7,'issued',$8,$9,$10)",[id(),req.user.shopId,customerId,reward.code,reward.label,reward.coins,reward.value,candidate,req.user.id,text(req.get("Idempotency-Key")||(req.body&&req.body.idempotencyKey))||null]);
          voucher=candidate;
        }catch(err){if(err.code!=="23505"||attempt===4)throw err;}
      }
      const saved=await client.query("SELECT * FROM loyalty_redemptions WHERE shop_id=$1 AND voucher_code=$2",[req.user.shopId,voucher]);
      await notify(req.user.shopId,"loyalty_redemption","Loyalty reward issued",customer.rows[0].name+" redeemed "+reward.coins+" coins for "+reward.label+" ("+voucher+").",{customerId,redemptionId:saved.rows[0].id,voucherCode:voucher},client);
      return {redemption:{id:saved.rows[0].id,rewardCode:reward.code,rewardLabel:reward.label,coinsSpent:reward.coins,rewardValue:reward.value,voucherCode:voucher,status:"issued",createdAt:saved.rows[0].created_at},customer:{id:customerId,name:customer.rows[0].name,coins:Number(updated.rows[0].coin_balance)},message:"Voucher "+voucher+" issued for "+reward.label+". Record the voucher at the counter; Easy Gateway does not process payment."};
    },201);
    await client.query("COMMIT");
    res.status(body.statusCode||201).json(body.body);
  }catch(err){await client.query("ROLLBACK").catch(()=>{});throw err;}
  finally{client.release();}
}));
app.get("/api/loyalty/redemptions",requireAuth,asyncRoute(async(req,res)=>{
  const r=await pool.query("SELECT r.*,c.name AS customer_name FROM loyalty_redemptions r JOIN customers c ON c.id=r.customer_id WHERE r.shop_id=$1 ORDER BY r.created_at DESC LIMIT 100",[req.user.shopId]);
  res.json({redemptions:r.rows.map(x=>({id:x.id,customerId:x.customer_id,customerName:x.customer_name,rewardCode:x.reward_code,rewardLabel:x.reward_label,coinsSpent:Number(x.coins_spent),rewardValue:Number(x.reward_value),status:x.status,voucherCode:x.voucher_code,createdAt:x.created_at}))});
}));

app.get("/api/products/:id/identifiers",requireAuth,asyncRoute(async(req,res)=>{
  const product=await pool.query("SELECT id,name FROM products WHERE id=$1 AND shop_id=$2 AND is_active=TRUE",[req.params.id,req.user.shopId]);
  if(!product.rowCount)throw fail(404,"Product not found.");
  const r=await pool.query("SELECT id,kind,value,is_primary,created_at,retired_at FROM product_identifiers WHERE shop_id=$1 AND product_id=$2 ORDER BY retired_at NULLS FIRST,kind,value",[req.user.shopId,req.params.id]);
  res.json({product:{id:product.rows[0].id,name:product.rows[0].name},identifiers:r.rows.map(x=>({id:x.id,kind:x.kind,value:x.value,primary:!!x.is_primary,createdAt:x.created_at,retiredAt:x.retired_at}))});
}));
app.post("/api/products/:id/identifiers",requireAuth,asyncRoute(async(req,res)=>{
  const kind=text(req.body.kind).toLowerCase(),value=text(req.body.value);
  if(!["barcode","sku","rfid"].includes(kind))throw fail(400,"Choose barcode, SKU or RFID as the identifier type.");
  if(!value||value.length>120||value.length<2)throw fail(400,"Enter an identifier between 2 and 120 characters.");
  if(kind!=="rfid"&&!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(value))throw fail(400,"Use letters, numbers, dot, dash, plus or underscore for a barcode or SKU.");
  const normalized=normalizeCode(value),client=await pool.connect();
  try{
    await client.query("BEGIN");
    const product=await client.query("SELECT id FROM products WHERE id=$1 AND shop_id=$2 AND is_active=TRUE FOR UPDATE",[req.params.id,req.user.shopId]);
    if(!product.rowCount)throw fail(404,"Product not found.");
    const existing=await client.query("SELECT * FROM product_identifiers WHERE shop_id=$1 AND kind=$2 AND normalized_value=$3 FOR UPDATE",[req.user.shopId,kind,normalized]);
    if(existing.rowCount){
      if(existing.rows[0].product_id!==req.params.id&&!existing.rows[0].retired_at)throw fail(409,"That "+kind+" is already linked to another product in this shop.");
      if(existing.rows[0].product_id===req.params.id&&!existing.rows[0].retired_at){await client.query("COMMIT");return res.json({identifier:{id:existing.rows[0].id,kind,value:existing.rows[0].value,primary:!!existing.rows[0].is_primary,retiredAt:null},alreadyLinked:true});}
      await client.query("UPDATE product_identifiers SET product_id=$2,value=$3,retired_at=NULL WHERE id=$1",[existing.rows[0].id,req.params.id,value]);
      await client.query("INSERT INTO product_identifier_events(id,shop_id,identifier_id,product_id,kind,value,action,actor_user_id) VALUES($1,$2,$3,$4,$5,$6,'updated',$7)",[id(),req.user.shopId,existing.rows[0].id,req.params.id,kind,value,req.user.id]);
      await client.query("COMMIT");
      return res.json({identifier:{id:existing.rows[0].id,kind,value,primary:!!existing.rows[0].is_primary,retiredAt:null},alreadyLinked:false});
    }
    const identifierId=id();
    await client.query("INSERT INTO product_identifiers(id,shop_id,product_id,kind,value,normalized_value,is_primary,created_by) VALUES($1,$2,$3,$4,$5,$6,FALSE,$7)",[identifierId,req.user.shopId,req.params.id,kind,value,normalized,req.user.id]);
    await client.query("INSERT INTO product_identifier_events(id,shop_id,identifier_id,product_id,kind,value,action,actor_user_id) VALUES($1,$2,$3,$4,$5,$6,'added',$7)",[id(),req.user.shopId,identifierId,req.params.id,kind,value,req.user.id]);
    await client.query("COMMIT");
    res.status(201).json({identifier:{id:identifierId,kind,value,primary:false,retiredAt:null},alreadyLinked:false});
  }catch(err){await client.query("ROLLBACK").catch(()=>{});if(err.code==="23505")throw fail(409,"That "+kind+" is already linked to another product in this shop.");throw err;}
  finally{client.release();}
}));
app.delete("/api/products/:id/identifiers/:identifierId",requireAuth,asyncRoute(async(req,res)=>{
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const r=await client.query("SELECT * FROM product_identifiers WHERE id=$1 AND product_id=$2 AND shop_id=$3 FOR UPDATE",[req.params.identifierId,req.params.id,req.user.shopId]);
    if(!r.rowCount)throw fail(404,"Identifier not found for this product.");
    if(r.rows[0].is_primary)throw fail(409,"The primary barcode or SKU is managed from the product form. Edit the product to change it.");
    if(!r.rows[0].retired_at){
      await client.query("UPDATE product_identifiers SET retired_at=NOW() WHERE id=$1",[r.rows[0].id]);
      await client.query("INSERT INTO product_identifier_events(id,shop_id,identifier_id,product_id,kind,value,action,actor_user_id) VALUES($1,$2,$3,$4,$5,$6,'retired',$7)",[id(),req.user.shopId,r.rows[0].id,req.params.id,r.rows[0].kind,r.rows[0].value,req.user.id]);
    }
    await client.query("COMMIT");
    res.json({ok:true});
  }catch(err){await client.query("ROLLBACK").catch(()=>{});throw err;}
  finally{client.release();}
}));

app.get("/api/sales",requireAuth,asyncRoute(async(req,res)=>{
  const r=await pool.query("SELECT * FROM sales WHERE shop_id=$1 ORDER BY created_at DESC LIMIT 300",[req.user.shopId]);
  res.json({sales:r.rows.map(saleDto)});
}));
app.post("/api/sales",requireAuth,asyncRoute(async(req,res)=>{
  const customerName=text(req.body.customerName),requestedCustomerId=text(req.body.customerId);
  if(customerName.length>120)throw fail(400,"Customer name must be 120 characters or fewer.");
  const requested=Array.isArray(req.body.items)&&req.body.items.length?req.body.items:[{productId:req.body.productId,quantity:req.body.quantity}];
  if(!requested.length||requested.length>50)throw fail(400,"A sale must contain between 1 and 50 product lines.");
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const replay=await readIdempotentReplay(req,client,"POST /api/sales");
    if(replay){await client.query("COMMIT");return res.status(replay.statusCode).json(replay.body);}
    const lines=[],mergeIndex=new Map(),seenSerials=new Set();
    for(const item of requested){
      const productId=text(item&&item.productId),code=text(item&&item.code),quantity=Number(item&&item.quantity),serials=parseSerialList(item&&item.serials);
      if(!Number.isFinite(quantity)||quantity<=0||quantity>1000000)throw fail(400,"Select a product and enter a positive quantity.");
      if(!productId&&!code)throw fail(400,"Each sale line needs a product or a scanned code.");
      for(const serial of serials){
        const normalized=normalizeCode(serial);
        if(seenSerials.has(normalized))throw fail(409,"Serial \""+serial+"\" was scanned more than once in this sale.");
        seenSerials.add(normalized);
      }
      if(productId&&!serials.length&&mergeIndex.has(productId)){
        mergeIndex.get(productId).quantity+=quantity;
      }else{
        const line={productId:productId||null,code,quantity,serials};
        lines.push(line);
        if(productId&&!serials.length)mergeIndex.set(productId,line);
      }
    }
    const ids=lines.map(l=>l.productId).filter(Boolean);
    let products=new Map();
    if(ids.length){
      const pr=await client.query("SELECT * FROM products WHERE shop_id=$1 AND is_active=TRUE AND id=ANY($2::text[]) ORDER BY id FOR UPDATE",[req.user.shopId,ids]);
      products=new Map(pr.rows.map(p=>[p.id,p]));
    }
    for(const line of lines){
      if(!line.productId){
        const normalized=normalizeCode(line.code);
        const found=await client.query("SELECT p.* FROM products p WHERE p.shop_id=$1 AND p.is_active=TRUE AND (LOWER(p.barcode)=LOWER($2) OR LOWER(p.sku)=LOWER($2) OR EXISTS(SELECT 1 FROM product_identifiers i WHERE i.product_id=p.id AND i.shop_id=p.shop_id AND i.retired_at IS NULL AND i.normalized_value=$3) OR EXISTS(SELECT 1 FROM serialized_units u WHERE u.product_id=p.id AND u.shop_id=p.shop_id AND u.normalized_serial=$3 AND u.status='in_stock')) ORDER BY (LOWER(p.barcode)=LOWER($2)) DESC,name LIMIT 1 FOR UPDATE",[req.user.shopId,line.code,normalized]);
        if(!found.rowCount)throw fail(404,"No active product matches \""+line.code+"\". Add it in Inventory first.");
        line.productId=found.rows[0].id;
        products.set(line.productId,found.rows[0]);
      }
      const p=products.get(line.productId);
      if(!p)throw fail(404,"One or more products are not active. Check expiry status and try again.");
      line.product=p;
    }
    const requestedQty=new Map();
    for(const line of lines)requestedQty.set(line.productId,(requestedQty.get(line.productId)||0)+line.quantity);
    for(const [productId,quantity] of requestedQty){
      const p=products.get(productId);
      if(Number(p.stock)<quantity)throw fail(409,"Insufficient stock for "+p.name+". Only "+Number(p.stock)+" "+p.unit+" remain.");
      if(p.track_serials&&!Number.isInteger(quantity))throw fail(409,p.name+" is serialized, so quantities must be whole numbers.");
    }
    for(const line of lines){
      const p=line.product;
      if(p.track_serials){
        if(!line.serials.length)throw fail(409,p.name+" tracks serial numbers. Scan or enter one serial per unit.");
        if(line.serials.length!==line.quantity)throw fail(409,"Scan exactly "+line.quantity+" serial number"+(line.quantity===1?"":"s")+" for "+p.name+".");
        const normalized=line.serials.map(normalizeCode);
        const units=await client.query("SELECT * FROM serialized_units WHERE shop_id=$1 AND product_id=$2 AND normalized_serial=ANY($3::text[]) AND status='in_stock' FOR UPDATE",[req.user.shopId,p.id,normalized]);
        if(units.rowCount!==normalized.length){
          const found=new Set(units.rows.map(u=>u.normalized_serial));
          const missing=line.serials.filter(s=>!found.has(normalizeCode(s)));
          throw fail(409,"These serial units are not available in stock for "+p.name+": "+missing.join(", ")+".");
        }
        line.units=units.rows;
      }else if(line.serials.length){
        throw fail(400,p.name+" does not track individual serial numbers. Remove the serial values and sell by quantity.");
      }
      line.total=Math.round(Number(p.selling_price)*line.quantity*100)/100;
    }
    const total=Math.round(lines.reduce((sum,line)=>sum+line.total,0)*100)/100;
    const setting=await client.query("SELECT coin_threshold FROM shop_settings WHERE shop_id=$1",[req.user.shopId]);
    const threshold=Math.max(1,Number(setting.rows[0]?.coin_threshold||100));
    let customerId=null,coins=0,displayCustomer="Walk-in customer";
    if(requestedCustomerId){
      const customer=await client.query("SELECT * FROM customers WHERE id=$1 AND shop_id=$2 FOR UPDATE",[requestedCustomerId,req.user.shopId]);
      if(!customer.rowCount)throw fail(404,"The selected customer was not found in this shop.");
      customerId=customer.rows[0].id;displayCustomer=customer.rows[0].name;
    }else if(customerName){
      const nameKey=customerName.toLocaleLowerCase("en-US");
      const customer=await client.query("INSERT INTO customers(id,shop_id,name,name_key) VALUES($1,$2,$3,$4) ON CONFLICT(shop_id,name_key) DO UPDATE SET name=customers.name RETURNING *",[id(),req.user.shopId,customerName,nameKey]);
      customerId=customer.rows[0].id;displayCustomer=customer.rows[0].name;
    }
    if(customerId)coins=Math.floor(total/threshold);
    const groupId=id(),sales=[];
    const balances=new Map();
    for(const [productId,p] of products)balances.set(productId,Number(p.stock));
    const body=await withIdempotency(req,client,"POST /api/sales",async()=>{
      for(let index=0;index<lines.length;index++){
        const line=lines[index],p=line.product;
        const balance=Math.round(((balances.get(p.id)||0)-line.quantity)*1000)/1000;
        if(balance<0)throw fail(409,"Insufficient stock for "+p.name+".");
        const updated=await client.query("UPDATE products SET stock=$3,updated_at=NOW() WHERE id=$1 AND shop_id=$2 AND stock>=$4 RETURNING stock",[p.id,req.user.shopId,balance,line.quantity]);
        if(!updated.rowCount)throw fail(409,"Insufficient stock for "+p.name+".");
        balances.set(p.id,balance);
        const saleId=id();
        const sale=await client.query("INSERT INTO sales(id,shop_id,product_id,product_name,customer_id,customer_name,quantity,unit_price,total,coins_earned,sale_group_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *",[saleId,req.user.shopId,p.id,p.name,customerId,displayCustomer,line.quantity,p.selling_price,line.total,index===0?coins:0,groupId]);
        if(line.units&&line.units.length){
          const unitIds=line.units.map(u=>u.id);
          const marked=await client.query("UPDATE serialized_units SET status='sold',sale_id=$3,updated_at=NOW() WHERE shop_id=$1 AND id=ANY($2::text[]) AND status='in_stock'",[req.user.shopId,unitIds,saleId]);
          if(marked.rowCount!==unitIds.length)throw fail(409,"A serial unit changed while this sale was being recorded. Scan the serials again.");
        }
        await recordMovement(client,{shopId:req.user.shopId,productId:p.id,type:"sale",delta:-line.quantity,balanceAfter:balance,unitCost:Number(p.unit_cost),reason:"Sale recorded",referenceType:"sale",referenceId:saleId,actorId:req.user.id});
        sales.push(sale.rows[0]);
      }
      if(customerId){
        await client.query("UPDATE customers SET coin_balance=coin_balance+$3,lifetime_spend=lifetime_spend+$4,order_count=order_count+1 WHERE id=$1 AND shop_id=$2",[customerId,req.user.shopId,coins,total]);
        if(coins>0)await client.query("INSERT INTO loyalty_transactions(id,shop_id,customer_id,sale_id,delta,reason) VALUES($1,$2,$3,$4,$5,'Purchase reward') ON CONFLICT DO NOTHING",[id(),req.user.shopId,customerId,sales[0].id,coins]);
      }
      return {sale:saleDto(sales[0]),sales:sales.map(saleDto),coinsEarned:coins,total,groupId,customer:displayCustomer};
    });
    await client.query("COMMIT");
    res.status(body.statusCode||201).json(body.body);
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
    await notify(req.user.shopId,"purchase_order","Purchase order draft created","Draft "+orderId.slice(0,8)+" created for "+lines.length+" products. It has not been sent to a supplier.",{purchaseOrderId:orderId},client);
    await client.query("COMMIT");
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
    const blocked=[];
    for(const item of items.rows){
      const outstanding=Number(item.quantity)-Number(item.received_quantity);
      if(outstanding<=0)continue;
      if(!item.product_id){blocked.push(item.product_name);continue;}
      const p=await client.query("UPDATE products SET stock=stock+$3,updated_at=NOW() WHERE id=$1 AND shop_id=$2 AND is_active=TRUE RETURNING id",[item.product_id,req.user.shopId,outstanding]);
      if(p.rowCount)await client.query("UPDATE purchase_order_items SET received_quantity=quantity WHERE id=$1",[item.id]);
      else blocked.push(item.product_name);
    }
    const pending=await client.query("SELECT COUNT(*)::int AS n FROM purchase_order_items WHERE purchase_order_id=$1 AND received_quantity<quantity",[req.params.id]);
    const status=Number(pending.rows[0].n)>0?"partially_received":"received";
    await client.query("UPDATE purchase_orders SET status=$2,received_at=CASE WHEN $2='received' THEN NOW() ELSE received_at END WHERE id=$1",[req.params.id,status]);
    if(blocked.length){
      const prior=await client.query("SELECT 1 FROM notifications WHERE shop_id=$1 AND kind='purchase_receive_blocked' AND payload->>'purchaseOrderId'=$2 LIMIT 1",[req.user.shopId,req.params.id]);
      if(!prior.rowCount)await notify(req.user.shopId,"purchase_receive_blocked","Purchase receipt needs attention","Stock was not added for "+blocked.join(", ")+" because the product is no longer active. Restore or correct the product, then receive the order again.",{purchaseOrderId:req.params.id,products:blocked},client);
    }
    await client.query("COMMIT");
    res.json({ok:true,status,warnings:blocked});
  }catch(err){await client.query("ROLLBACK").catch(()=>{});throw err;}
  finally{client.release();}
}));

app.get("/api/recycle-bin",requireAuth,asyncRoute(async(req,res)=>{
  const r=await pool.query("SELECT * FROM recycle_bin WHERE shop_id=$1 AND restored_at IS NULL AND deleted_at IS NULL ORDER BY recycled_at DESC",[req.user.shopId]);
  res.json({items:r.rows.map(recycleBinDto)});
}));
function recycleBinDto(x){
  return {id:x.id,productId:x.product_id,product:x.product_snapshot,stockAtExpiry:Number(x.stock_at_expiry),expiry:dateOnly(x.expiry_date),reason:x.reason,recycledAt:x.recycled_at,recordedQuantity:x.recorded_quantity==null?null:Number(x.recorded_quantity),recordedLoss:x.recorded_loss==null?null:Number(x.recorded_loss),wasteMethod:x.waste_method||"",wasteNote:x.waste_note||"",wasteRecordedAt:x.waste_recorded_at||null};
}
app.post("/api/recycle-bin/:id/waste",requireAuth,asyncRoute(async(req,res)=>{
  const quantity=Number(req.body.quantity),method=text(req.body.method)||"Recorded disposal",note=text(req.body.note);
  const providedLoss=req.body.loss===undefined||req.body.loss===""?null:Number(req.body.loss);
  if(!Number.isFinite(quantity)||quantity<=0||quantity>1000000)throw fail(400,"Enter the quantity actually disposed as a positive number.");
  if(method.length<2||method.length>60)throw fail(400,"Describe the disposal method in 2–60 characters.");
  if(note.length>300)throw fail(400,"Waste notes must be 300 characters or fewer.");
  if(providedLoss!==null&&(!Number.isFinite(providedLoss)||providedLoss<0))throw fail(400,"Recorded loss must be a non-negative amount.");
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const rr=await client.query("SELECT * FROM recycle_bin WHERE id=$1 AND shop_id=$2 AND restored_at IS NULL AND deleted_at IS NULL FOR UPDATE",[req.params.id,req.user.shopId]);
    if(!rr.rowCount)throw fail(404,"Recycle-bin record not found.");
    const row=rr.rows[0];
    if(row.recorded_quantity!=null)throw fail(409,"Waste has already been recorded for this expired batch. The existing record is kept to avoid double-counting loss.");
    if(quantity>Number(row.stock_at_expiry))throw fail(409,"Disposed quantity cannot exceed the "+Number(row.stock_at_expiry)+" units recorded at expiry.");
    const unitCost=Number(row.product_snapshot?.cost||0);
    const loss=providedLoss===null?Math.round(quantity*unitCost*100)/100:Math.round(providedLoss*100)/100;
    const r=await client.query("UPDATE recycle_bin SET recorded_quantity=$3,recorded_loss=$4,waste_method=$5,waste_note=$6,waste_recorded_by=$7,waste_recorded_at=NOW() WHERE id=$1 AND shop_id=$2 RETURNING *",[row.id,req.user.shopId,quantity,loss,method,note,req.user.id]);
    const name=row.product_snapshot?.name||"Expired product";
    await notify(req.user.shopId,"expiry_waste","Expiry waste recorded",name+": "+quantity+" unit"+(quantity===1?"":"s")+" disposed via "+method+". Recorded cost "+loss+".",{recycleBinId:row.id,quantity,loss,method},client);
    await client.query("COMMIT");
    res.json({item:recycleBinDto(r.rows[0])});
  }catch(err){await client.query("ROLLBACK").catch(()=>{});throw err;}
  finally{client.release();}
}));

app.get("/api/reports/expiry-waste",requireAuth,asyncRoute(async(req,res)=>{
  const shopId=req.user.shopId;
  const settings=await pool.query("SELECT timezone FROM shop_settings WHERE shop_id=$1",[shopId]);
  if(!settings.rowCount)throw fail(404,"Shop settings were not found.");
  const range=await pool.query("SELECT TO_CHAR((NOW() AT TIME ZONE $1)::date,'YYYY-MM-DD') AS today,TO_CHAR((DATE_TRUNC('month',NOW() AT TIME ZONE $1)-INTERVAL '11 months')::date,'YYYY-MM-DD') AS default_from",[settings.rows[0].timezone||"Asia/Kolkata"]);
  const from=text(req.query.from)||range.rows[0].default_from,to=text(req.query.to)||range.rows[0].today;
  if(!validDateRange(from,to))throw fail(400,"Enter a valid date range with the start date on or before the end date.");
  const where=" FROM recycle_bin WHERE shop_id=$1 AND restored_at IS NULL AND deleted_at IS NULL AND expiry_date BETWEEN $2::date AND $3::date";
  const costExpr="COALESCE(NULLIF(product_snapshot->>'cost','')::numeric,0)";
  const wasteExpr="COALESCE(SUM(recorded_loss) FILTER(WHERE waste_recorded_at IS NOT NULL),0)::numeric(14,2)";
  const wasteQtyExpr="COALESCE(SUM(recorded_quantity) FILTER(WHERE waste_recorded_at IS NOT NULL),0)::numeric(14,3)";
  const [summary,monthly,products]=await Promise.all([
    pool.query("SELECT COUNT(*)::int AS expired_records,COUNT(*) FILTER(WHERE stock_at_expiry>0)::int AS records_with_stock,COALESCE(SUM(stock_at_expiry),0)::numeric(14,3) AS quantity,COALESCE(SUM(stock_at_expiry*"+costExpr+"),0)::numeric(14,2) AS estimated_loss,COUNT(*) FILTER(WHERE waste_recorded_at IS NOT NULL)::int AS recorded_records,"+wasteQtyExpr+" AS recorded_quantity,"+wasteExpr+" AS recorded_loss"+where,[shopId,from,to]),
    pool.query("SELECT TO_CHAR(DATE_TRUNC('month',expiry_date::timestamp),'YYYY-MM') AS month,COUNT(*)::int AS records,COALESCE(SUM(stock_at_expiry),0)::numeric(14,3) AS quantity,COALESCE(SUM(stock_at_expiry*"+costExpr+"),0)::numeric(14,2) AS estimated_loss,COUNT(*) FILTER(WHERE waste_recorded_at IS NOT NULL)::int AS recorded_records,"+wasteQtyExpr+" AS recorded_quantity,"+wasteExpr+" AS recorded_loss"+where+" GROUP BY 1 ORDER BY 1",[shopId,from,to]),
    pool.query("SELECT COALESCE(product_snapshot->>'id',product_id) AS product_id,COALESCE(product_snapshot->>'name','Unknown product') AS name,COALESCE(product_snapshot->>'category','General retail') AS category,COUNT(*)::int AS records,COALESCE(SUM(stock_at_expiry),0)::numeric(14,3) AS quantity,COALESCE(SUM(stock_at_expiry*"+costExpr+"),0)::numeric(14,2) AS estimated_loss,COUNT(*) FILTER(WHERE waste_recorded_at IS NOT NULL)::int AS recorded_records,"+wasteQtyExpr+" AS recorded_quantity,"+wasteExpr+" AS recorded_loss"+where+" GROUP BY 1,2,3 ORDER BY 6 DESC,2 LIMIT 10",[shopId,from,to])
  ]);
  const n=v=>Number(v)||0;
  res.set("Cache-Control","no-store").json({from,to,summary:{expiredRecords:n(summary.rows[0].expired_records),recordsWithStock:n(summary.rows[0].records_with_stock),quantity:n(summary.rows[0].quantity),estimatedLoss:n(summary.rows[0].estimated_loss),recordedRecords:n(summary.rows[0].recorded_records),recordedQuantity:n(summary.rows[0].recorded_quantity),recordedLoss:n(summary.rows[0].recorded_loss)},monthly:monthly.rows.map(r=>({month:r.month,records:n(r.records),quantity:n(r.quantity),estimatedLoss:n(r.estimated_loss),recordedRecords:n(r.recorded_records),recordedQuantity:n(r.recorded_quantity),recordedLoss:n(r.recorded_loss)})),products:products.rows.map(r=>({productId:r.product_id,name:r.name,category:r.category,records:n(r.records),quantity:n(r.quantity),estimatedLoss:n(r.estimated_loss),recordedRecords:n(r.recorded_records),recordedQuantity:n(r.recorded_quantity),recordedLoss:n(r.recorded_loss)}))});
}));

app.post("/api/qr-tokens",requireAuth,rateLimit({windowMs:15*60*1000,limit:60,standardHeaders:"draft-8",legacyHeaders:false,message:{error:"Too many QR codes generated. Try again in a few minutes."}}),asyncRoute(async(req,res)=>{
  const productId=text(req.body.productId);
  if(!productId)throw fail(400,"Choose a product to generate its QR code.");
  const product=await pool.query("SELECT p.id,p.name FROM products p WHERE p.id=$1 AND p.shop_id=$2 AND p.is_active=TRUE",[productId,req.user.shopId]);
  if(!product.rowCount)throw fail(404,"That product is not active in this shop.");
  await pool.query("DELETE FROM product_qr_tokens WHERE expires_at<NOW()-INTERVAL '1 day' OR consumed_at<NOW()-INTERVAL '1 day'");
  const token=createQrToken(),expiresAt=new Date(Date.now()+2*60*1000).toISOString();
  await pool.query("INSERT INTO product_qr_tokens(id,shop_id,product_id,token_hash,expires_at) VALUES($1,$2,$3,$4,$5)",[id(),req.user.shopId,productId,hashQrToken(token),expiresAt]);
  const origin=resolvePublicOrigin(req);
  const scanUrl=new URL("/scan/"+token,origin).toString();
  const qrDataUrl=await QRCode.toDataURL(scanUrl,{errorCorrectionLevel:"M",width:320,margin:2,color:{dark:"#203a29",light:"#ffffff"}});
  res.status(201).set("Cache-Control","no-store").json({productId,productName:product.rows[0].name,token,scanUrl,qrDataUrl,expiresAt});
}));
app.get("/api/qr-tokens/:token/status",requireAuth,asyncRoute(async(req,res)=>{
  const token=text(req.params.token);
  if(!/^[A-Za-z0-9_-]{43}$/.test(token))return res.json({consumed:true,expired:true});
  const result=await pool.query("SELECT consumed_at,expires_at,(expires_at<=NOW()) AS expired FROM product_qr_tokens WHERE token_hash=$1 AND shop_id=$2",[hashQrToken(token),req.user.shopId]);
  if(!result.rowCount)return res.json({consumed:true,expired:true});
  res.set("Cache-Control","no-store").json({consumed:!!result.rows[0].consumed_at,expired:!!result.rows[0].expired,expiresAt:result.rows[0].expires_at});
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
    if(isBeforeDate(expiry,today.rows[0]?.today))throw fail(400,"Restore blocked: expiry date is still in the past.");
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
  const shops=await pool.query("SELECT shop_id,max_auto_purchase_amount,timezone FROM shop_settings WHERE auto_purchase_enabled=TRUE");
  for(const shop of shops.rows){
    try{
      const plan=await getPurchasePlan(shop.shop_id);if(!plan.items.length)continue;
      const open=await pool.query("SELECT 1 FROM purchase_orders WHERE shop_id=$1 AND source='automation' AND status IN ('approved_awaiting_supplier','submitted','partially_received') LIMIT 1",[shop.shop_id]);
      if(open.rowCount)continue;
      const tz=shop.timezone||"Asia/Kolkata";
      if(plan.estimatedTotal>Number(shop.max_auto_purchase_amount)){
        const today=new Intl.DateTimeFormat("en-CA",{timeZone:tz,year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
        const prior=await pool.query("SELECT 1 FROM notifications WHERE shop_id=$1 AND kind='purchase_limit' AND payload->>'date'=$2 LIMIT 1",[shop.shop_id,today]);
        if(!prior.rowCount)await notify(shop.shop_id,"purchase_limit","Purchase requires review","Suggested purchase total "+plan.estimatedTotal+" exceeds the configured auto-purchase limit of "+Number(shop.max_auto_purchase_amount)+".",{date:today,estimatedTotal:plan.estimatedTotal,limit:Number(shop.max_auto_purchase_amount)});
        continue;
      }
      const poId=id(),client=await pool.connect();
      try{
        await client.query("BEGIN");
        await client.query("INSERT INTO purchase_orders(id,shop_id,status,source,total_cost) VALUES($1,$2,'approved_awaiting_supplier','automation',$3)",[poId,shop.shop_id,plan.estimatedTotal]);
        for(const line of plan.items)await client.query("INSERT INTO purchase_order_items(id,purchase_order_id,product_id,product_name,quantity,unit_cost) VALUES($1,$2,$3,$4,$5,$6)",[id(),poId,line.productId,line.name,line.quantity,line.unitCost]);
        await notify(shop.shop_id,"purchase_automation","Purchase order prepared automatically","An order totaling "+plan.estimatedTotal+" was created within your limit. External supplier submission is not connected; send it through an authorized supplier channel.",{purchaseOrderId:poId,estimatedTotal:plan.estimatedTotal},client);
        await client.query("COMMIT");
      }catch(err){await client.query("ROLLBACK").catch(()=>{});throw err;}
      finally{client.release();}
    }catch(err){console.error("Auto-purchase cycle failed for shop",shop.shop_id,err.message);}
  }
}


function generateDemoProduct(){
 const catalogue=[
 {name:"Premium Basmati Rice 1 kg",category:"Grocery",unit:"bag",min:78,max:108,expiry:true},
 {name:"Toor Dal 1 kg",category:"Grocery",unit:"bag",min:92,max:125,expiry:true},
 {name:"Sunflower Oil 1 L",category:"Grocery",unit:"bottle",min:112,max:145,expiry:true},
 {name:"Tata Salt 1 kg",category:"Grocery",unit:"pack",min:18,max:25,expiry:true},
 {name:"Wheat Flour 5 kg",category:"Grocery",unit:"bag",min:190,max:240,expiry:true},
 {name:"Filter Coffee 200 g",category:"Beverages",unit:"pack",min:98,max:138,expiry:true},
 {name:"Bath Soap 125 g",category:"Personal care",unit:"bar",min:28,max:42,expiry:false},
 {name:"Dishwash Liquid 500 ml",category:"Household",unit:"bottle",min:79,max:115,expiry:false},
 {name:"Laundry Detergent 1 kg",category:"Household",unit:"pack",min:115,max:165,expiry:false},
 {name:"Notebook A4 200 pages",category:"Stationery",unit:"piece",min:65,max:92,expiry:false},
 {name:"Ball Pen Blue 10-pack",category:"Stationery",unit:"pack",min:48,max:75,expiry:false},
 {name:"LED Bulb 9 W",category:"Electronics",unit:"piece",min:72,max:110,expiry:false},
 {name:"Toothpaste 150 g",category:"Personal care",unit:"tube",min:88,max:125,expiry:true},
 {name:"Biscuits Family Pack",category:"Snacks",unit:"pack",min:30,max:55,expiry:true},
 {name:"Groundnut Oil 1 L",category:"Grocery",unit:"bottle",min:135,max:175,expiry:true},
 {name:"Chickpeas 1 kg",category:"Grocery",unit:"bag",min:78,max:112,expiry:true},
 {name:"Handwash 250 ml",category:"Personal care",unit:"bottle",min:62,max:89,expiry:true},
 {name:"Garbage Bags 30-pack",category:"Household",unit:"pack",min:74,max:99,expiry:false}
 ];
 const item=catalogue[crypto.randomInt(catalogue.length)],cost=crypto.randomInt(item.min,item.max+1),price=Math.ceil(cost*(1.16+crypto.randomInt(0,18)/100));
 const stock=crypto.randomInt(6,51),days=crypto.randomInt(21,181);
 return {name:item.name,sku:"DEMO-"+crypto.randomBytes(3).toString("hex").toUpperCase(),category:item.category,unit:item.unit,stock,reorderAt:crypto.randomInt(3,11),cost,price,leadTimeDays:crypto.randomInt(1,8),expiry:item.expiry?new Date(Date.now()+days*86400000).toISOString().slice(0,10):null,isDemo:true,demoNote:"Synthetic demo catalogue item"};
}
function importLandingPage(token,demoOnly){
 const t=String(token||"");
 if(!/^[A-Za-z0-9_-]{43}$/.test(t))return '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>QR code unavailable · Easy Gateway</title><style>body{font:16px/1.6 system-ui,sans-serif;background:#f5f7f3;color:#26372a;padding:22px}.card{max-width:520px;margin:7vh auto;background:#fff;border:1px solid #dfe7da;border-radius:16px;padding:28px}</style><main class="card"><h1>QR code unavailable</h1><p>This code is invalid. Generate a fresh sample product QR.</p><a href="/">Open Easy Gateway</a></main></html>';
 const demoUrl='/?mode=demo&page=scanner&scanToken='+encodeURIComponent(t),liveUrl='/?scanToken='+encodeURIComponent(t);
 const content=demoOnly
  ? '<p>This is a sandbox-only sample. The product will be added to local Demo Mode data, never to a retailer database.</p><p id="status">Opening Demo Mode scanner…</p><p><a href="'+demoUrl+'">Continue to demo inventory</a></p><script>window.location.replace('+JSON.stringify(demoUrl)+');</script>'
  : '<p id="status">Checking sign-in and adding this sample product…</p><p><a href="'+liveUrl+'">Continue in Easy Gateway</a></p><script>const token='+JSON.stringify(t)+';const status=document.getElementById("status");fetch("/api/auth/me",{credentials:"same-origin"}).then(async r=>{if(!r.ok){window.location.replace("/?scanToken="+encodeURIComponent(token));return null;}return fetch("/api/product-import/consume",{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify({token})});}).then(async r=>{if(!r)return;const d=await r.json();if(!r.ok)throw new Error(d.error||"This code is no longer available.");status.textContent="Added "+d.product.name+" to "+(d.shopName||"your shop")+" inventory.";}).catch(e=>{status.textContent=e.message+" If required, sign in through Easy Gateway and retry with a fresh QR.";});</script>';
 return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Import sample product · Easy Gateway</title><style>body{font:15px/1.6 system-ui,sans-serif;background:#f5f7f3;color:#26372a;margin:0;padding:22px}.card{max-width:520px;margin:6vh auto;background:#fff;border:1px solid #dfe7da;border-radius:16px;padding:28px;box-shadow:0 12px 32px #203a2910}h1{font-size:25px;margin:0 0 10px}p{color:#697765}a,.tag{color:#315d3d;font-weight:700}.tag{background:#edf4e9;padding:5px 8px;border-radius:5px;font-size:11px}</style></head><body><main class="card"><span class="tag">ONE-TIME PRODUCT IMPORT</span><h1>Sample product QR</h1>'+content+'<p>This code expires after 15 minutes or one successful scan. Live-mode imports are added to the real shop inventory; demo imports stay inside Demo Mode.</p></main></body></html>';
}

app.post("/api/demo-product-qr",rateLimit({windowMs:15*60*1000,limit:60,standardHeaders:"draft-8",legacyHeaders:false,message:{error:"Too many demo QR codes generated. Please try later."}}),asyncRoute(async(req,res)=>{
 const product=generateDemoProduct(),token=createQrToken(),demoOnly=req.body?.demoMode===true,expiresAt=new Date(Date.now()+15*60*1000).toISOString();
 await pool.query("DELETE FROM product_import_qr_tokens WHERE expires_at<NOW()-INTERVAL '1 day' OR consumed_at<NOW()-INTERVAL '1 day'");
 await pool.query("INSERT INTO product_import_qr_tokens(id,token_hash,product_snapshot,expires_at,demo_only) VALUES($1,$2,$3::jsonb,$4,$5)",[id(),hashQrToken(token),JSON.stringify(product),expiresAt,demoOnly]);
 const origin=resolvePublicOrigin(req),url=new URL("/import-product/"+token,origin);
 if(demoOnly)url.searchParams.set("mode","demo");
 const qrDataUrl=await QRCode.toDataURL(url.toString(),{errorCorrectionLevel:"M",width:360,margin:2,color:{dark:"#203a29",light:"#ffffff"}});
 res.status(201).set("Cache-Control","no-store").json({token,product,scanUrl:url.toString(),qrDataUrl,expiresAt,demoMode:demoOnly});
}));
app.get("/api/demo-product-qr/:token/status",asyncRoute(async(req,res)=>{
 const token=text(req.params.token);if(!/^[A-Za-z0-9_-]{43}$/.test(token))return res.json({consumed:true,expired:true});
 const r=await pool.query("SELECT consumed_at,expires_at,(expires_at<=NOW()) AS expired FROM product_import_qr_tokens WHERE token_hash=$1",[hashQrToken(token)]);
 if(!r.rowCount)return res.json({consumed:true,expired:true});
 res.set("Cache-Control","no-store").json({consumed:!!r.rows[0].consumed_at,expired:!!r.rows[0].expired,expiresAt:r.rows[0].expires_at});
}));
app.post("/api/demo-product-qr/consume-preview",rateLimit({windowMs:15*60*1000,limit:60,standardHeaders:"draft-8",legacyHeaders:false}),asyncRoute(async(req,res)=>{
 const token=text(req.body.token);if(!/^[A-Za-z0-9_-]{43}$/.test(token))throw fail(400,"QR token is invalid.");
 const client=await pool.connect();
 try{
  await client.query("BEGIN");const r=await client.query("SELECT * FROM product_import_qr_tokens WHERE token_hash=$1 FOR UPDATE",[hashQrToken(token)]);
  if(!r.rowCount||!r.rows[0].demo_only||r.rows[0].consumed_at||new Date(r.rows[0].expires_at)<=new Date())throw fail(410,"This demo-only QR has expired, is not a demo token, or has already been scanned. Generate a fresh code.");
  const product=r.rows[0].product_snapshot;await client.query("UPDATE product_import_qr_tokens SET consumed_at=NOW() WHERE id=$1",[r.rows[0].id]);
  await client.query("COMMIT");res.set("Cache-Control","no-store").json({ok:true,product,demoOnly:true});
 }catch(err){await client.query("ROLLBACK").catch(()=>{});throw err;}finally{client.release();}
}));
app.post("/api/product-import/consume",requireAuth,rateLimit({windowMs:15*60*1000,limit:60,standardHeaders:"draft-8",legacyHeaders:false}),asyncRoute(async(req,res)=>{
 const token=text(req.body.token);if(!/^[A-Za-z0-9_-]{43}$/.test(token))throw fail(400,"QR token is invalid.");
 const shopId=req.user.shopId,client=await pool.connect();
 try{
  await client.query("BEGIN");const t=await client.query("SELECT * FROM product_import_qr_tokens WHERE token_hash=$1 FOR UPDATE",[hashQrToken(token)]);
  if(!t.rowCount||t.rows[0].demo_only||t.rows[0].consumed_at||new Date(t.rows[0].expires_at)<=new Date())throw fail(410,"This live import QR has expired, is a demo-only code, or has already been scanned. Generate a fresh code.");
  const p=t.rows[0].product_snapshot;let sku=text(p.sku).slice(0,90);
  if((await client.query("SELECT 1 FROM products WHERE shop_id=$1 AND LOWER(sku)=LOWER($2)",[shopId,sku])).rowCount)sku=sku+"-"+crypto.randomBytes(2).toString("hex").toUpperCase();
  const product=await client.query("INSERT INTO products(id,shop_id,name,sku,category,unit,stock,reorder_at,unit_cost,selling_price,lead_time_days,expiry_date,is_demo) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,FALSE) RETURNING *",[id(),shopId,p.name,sku,p.category,p.unit,p.stock,p.reorderAt,p.cost,p.price,p.leadTimeDays,p.expiry||null]);
  await client.query("UPDATE product_import_qr_tokens SET consumed_at=NOW(),consumed_by_shop_id=$2 WHERE id=$1",[t.rows[0].id,shopId]);
  await notify(shopId,"product_added","Product added from QR code",p.name+" was added to live inventory from a one-time QR code.",{productId:product.rows[0].id,source:"qr_live"},client);
  await client.query("COMMIT");res.status(201).set("Cache-Control","no-store").json({ok:true,product:productDto(product.rows[0]),shopName:req.user.shopName});
 }catch(err){await client.query("ROLLBACK").catch(()=>{});throw err;}finally{client.release();}
}));
app.get("/import-product/:token",asyncRoute(async(req,res)=>{
 const token=text(req.params.token);if(!/^[A-Za-z0-9_-]{43}$/.test(token))return res.status(410).type("html").send(importLandingPage("",true));
 res.set("Cache-Control","no-store, max-age=0").type("html").send(importLandingPage(token,req.query.mode==="demo"));
}));
function publicCustomerProduct(p){return {id:p.id,name:p.name,sku:p.sku,category:p.category,unit:p.unit,price:Number(p.selling_price),available:Number(p.stock)>0};}
app.get("/api/customer/catalog/:slug",asyncRoute(async(req,res)=>{
 const shop=await pool.query("SELECT id,name,public_slug FROM shops WHERE public_slug=$1",[text(req.params.slug)]);
 if(!shop.rowCount)throw fail(404,"This customer store link is not available.");
 const rows=await pool.query("SELECT id,name,sku,category,unit,stock,selling_price FROM products WHERE shop_id=$1 AND is_active=TRUE ORDER BY category,name",[shop.rows[0].id]);
 res.set("Cache-Control","no-store").json({shop:{name:shop.rows[0].name,slug:shop.rows[0].public_slug},products:rows.rows.map(publicCustomerProduct)});
}));
function orderEventMessage(status,reference){
 const messages={
  requested:"Order request "+reference+" received. Awaiting shop confirmation.",
  accepted:"Order "+reference+" confirmed by the shop.",
  declined:"Order "+reference+" was not accepted by the shop.",
  ready:"Order "+reference+" is ready for pickup or delivery.",
  fulfilled:"Order "+reference+" was completed.",
  cancelled:"Order "+reference+" was cancelled."
 };
 return messages[status]||("Order "+reference+" updated to "+status+".");
}
app.post("/api/customer/orders",rateLimit({windowMs:60*60*1000,limit:12,standardHeaders:"draft-8",legacyHeaders:false,message:{error:"Too many order requests from this connection. Please try again later."}}),asyncRoute(async(req,res)=>{
 const slug=text(req.body.shopSlug),name=text(req.body.name),phone=text(req.body.phone),email=text(req.body.email).toLowerCase(),address=text(req.body.address),notes=text(req.body.notes),requested=Array.isArray(req.body.items)?req.body.items:[];
 const clientRequestId=text(req.body.clientRequestId||req.get("Idempotency-Key"));
 if(name.length<2||name.length>100)throw fail(400,"Enter your name (2–100 characters).");
 if(!/^[+0-9() .-]{7,24}$/.test(phone)||phone.replace(/\D/g,"").length<7)throw fail(400,"Enter a valid contact phone number.");
 if(!validEmail(email))throw fail(400,"Enter a valid email address for the order confirmation.");
 if(address.length<5||address.length>300)throw fail(400,"Enter a delivery or pickup address (5–300 characters).");
 if(notes.length>500||!requested.length||requested.length>30)throw fail(400,"Choose at least one product and keep notes under 500 characters.");
 if(clientRequestId&&!/^[A-Za-z0-9._:-]{8,160}$/.test(clientRequestId))throw fail(400,"The order request key is invalid. Reload the store and try again.");
 const client=await pool.connect();
 try{
  await client.query("BEGIN");const shop=await client.query("SELECT id,name FROM shops WHERE public_slug=$1 FOR SHARE",[slug]);
  if(!shop.rowCount)throw fail(404,"This customer store link is not available.");
  if(clientRequestId){
   const prior=await client.query("SELECT * FROM customer_orders WHERE shop_id=$1 AND client_request_id=$2",[shop.rows[0].id,clientRequestId]);
   if(prior.rowCount){
    await client.query("COMMIT");
    return res.status(200).set("Cache-Control","no-store").json({order:{...customerOrderDto(prior.rows[0]),shopName:shop.rows[0].name},duplicate:true,notifications:{emailQueued:false,shopNotified:false,message:"This order request was already saved, so the existing reference was returned instead of creating a duplicate order."}});
   }
  }
  let total=0;const items=[];
  for(const item of requested){
   const productId=text(item.productId),quantity=Number(item.quantity);
   if(!productId||!Number.isInteger(quantity)||quantity<1||quantity>100)throw fail(400,"Order quantity must be a whole number between 1 and 100.");
   const p=await client.query("SELECT id,name,sku,unit,stock,selling_price FROM products WHERE id=$1 AND shop_id=$2 AND is_active=TRUE FOR SHARE",[productId,shop.rows[0].id]);
   if(!p.rowCount)throw fail(409,"One product is no longer available. Refresh the catalogue.");
   if(Number(p.rows[0].stock)<quantity)throw fail(409,"Not enough stock is currently available for "+p.rows[0].name+".");
   const unitPrice=Number(p.rows[0].selling_price),lineTotal=Math.round(unitPrice*quantity*100)/100;total+=lineTotal;
   items.push({productId:p.rows[0].id,name:p.rows[0].name,sku:p.rows[0].sku,unit:p.rows[0].unit,quantity,unitPrice,lineTotal});
  }
  let orderId=id(),reference=orderReference();
  for(let attempt=0;attempt<5;attempt++){
   try{
    await client.query("INSERT INTO customer_orders(id,shop_id,customer_name,customer_phone,customer_email,customer_address,reference_code,notes,items,total,status,email_status,client_request_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,'requested','not_sent',$11)",[orderId,shop.rows[0].id,name,phone,email,address,reference,notes,JSON.stringify(items),Math.round(total*100)/100,clientRequestId||null]);
    break;
   }catch(err){
    if(err.constraint==="customer_orders_client_request_unique"){
     // The failed INSERT aborted the transaction, so roll back before reading the
     // row that the concurrent request committed.
     await client.query("ROLLBACK");
     const prior=await client.query("SELECT * FROM customer_orders WHERE shop_id=$1 AND client_request_id=$2",[shop.rows[0].id,clientRequestId]);
     if(prior.rowCount)return res.status(200).set("Cache-Control","no-store").json({order:{...customerOrderDto(prior.rows[0]),shopName:shop.rows[0].name},duplicate:true,notifications:{emailQueued:false,shopNotified:false,message:"This order request was already saved, so the existing reference was returned instead of creating a duplicate order."}});
     throw err;
    }
    if(err.code!=="23505"||attempt===4)throw err;
    orderId=id();reference=orderReference();
   }
  }
  const order={id:orderId,shopId:shop.rows[0].id,shop_id:shop.rows[0].id,referenceCode:reference,reference_code:reference,customerName:name,customer_name:name,customerPhone:phone,customer_phone:phone,customerEmail:email,customer_email:email,customerAddress:address,customer_address:address,notes,items,total:Math.round(total*100)/100,status:"requested",createdAt:new Date().toISOString()};
  await client.query("INSERT INTO customer_order_events(id,shop_id,order_id,type,actor,message) VALUES($1,$2,$3,'requested','customer',$4)",[id(),shop.rows[0].id,orderId,orderEventMessage("requested",reference)]);
  const context=await shopContext(shop.rows[0].id,client);
  const customerQueued=await enqueueOrderEmail(client,context,order,"requested_customer",email);
  const shopQueued=await enqueueOrderEmail(client,context,order,"requested_shop",context.ownerEmail);
  await refreshOrderEmailStatus(client,orderId);
  const saved=await client.query("SELECT * FROM customer_orders WHERE id=$1",[orderId]);
  await client.query("COMMIT");
  scheduleEmailProcessing();
  res.status(201).set("Cache-Control","no-store").json({order:{...customerOrderDto(saved.rows[0]),shopName:shop.rows[0].name},notifications:{emailQueued:customerQueued,shopNotified:shopQueued,message:customerQueued?"A confirmation email has been queued. Delivery depends on the shop's email provider. This is still an order request until the shop confirms it.":"This request is saved, but email delivery is not configured. The shop can still see it in Easy Gateway."}});
 }catch(err){await client.query("ROLLBACK").catch(()=>{});throw err;}finally{client.release();}
}));
app.get("/api/customer/orders/:reference",asyncRoute(async(req,res)=>{
 const reference=text(req.params.reference).toUpperCase(),phone=text(req.query.phone);
 if(!reference||reference.length>40)throw fail(400,"Enter a valid order reference.");
 const digits=phone.replace(/\D/g,"");
 if(digits.length<7)throw fail(400,"Enter the phone number used for the order.");
 const r=await pool.query("SELECT o.*,s.name AS shop_name FROM customer_orders o JOIN shops s ON s.id=o.shop_id WHERE UPPER(o.reference_code)=UPPER($1) AND REGEXP_REPLACE(o.customer_phone,'[^0-9]','','g')=$2 ORDER BY o.created_at DESC LIMIT 1",[reference,digits]);
 if(!r.rowCount)throw fail(404,"No order matches that reference and phone number.");
 const events=await pool.query("SELECT type,actor,message,created_at FROM customer_order_events WHERE order_id=$1 ORDER BY created_at",[r.rows[0].id]);
 res.set("Cache-Control","no-store").json({order:{...customerOrderDto(r.rows[0]),shopName:r.rows[0].shop_name,events:events.rows.map(e=>({type:e.type,actor:e.actor,message:e.message,createdAt:e.created_at}))}});
}));
app.post("/api/customer/orders/:reference/resend",rateLimit({windowMs:15*60*1000,limit:5,standardHeaders:"draft-8",legacyHeaders:false,message:{error:"Too many resend attempts. Try again later."}}),asyncRoute(async(req,res)=>{
 const reference=text(req.params.reference).toUpperCase(),phone=text(req.body.phone),digits=phone.replace(/\D/g,"");
 if(!reference||digits.length<7)throw fail(400,"Enter the order reference and phone number.");
 const client=await pool.connect();
 try{
  await client.query("BEGIN");
  const found=await client.query("SELECT o.*,s.name AS shop_name FROM customer_orders o JOIN shops s ON s.id=o.shop_id WHERE UPPER(o.reference_code)=UPPER($1) AND REGEXP_REPLACE(o.customer_phone,'[^0-9]','','g')=$2 LIMIT 1 FOR UPDATE OF o",[reference,digits]);
  if(!found.rowCount)throw fail(404,"No order matches that reference and phone number.");
  const order=found.rows[0];
  const existing=await client.query("SELECT status FROM email_outbox WHERE dedupe_key=$1",["order:"+order.id+":requested_customer"]);
  if(existing.rowCount&&existing.rows[0].status==="sent"){await client.query("COMMIT");return res.json({ok:true,alreadySent:true,message:"The confirmation email was already sent."});}
  if(existing.rowCount){
   await client.query("UPDATE email_outbox SET status='queued',attempts=0,last_error='',next_attempt_at=NOW(),updated_at=NOW() WHERE dedupe_key=$1",["order:"+order.id+":requested_customer"]);
  }else{
   await enqueueOrderEmail(client,await shopContext(order.shop_id,client),order,"requested_customer",order.customer_email);
  }
  await refreshOrderEmailStatus(client,order.id);
  await client.query("COMMIT");
  scheduleEmailProcessing();
  res.json({ok:true,alreadySent:false,message:"The confirmation email was queued again. Delivery depends on the shop's email provider."});
 }catch(err){await client.query("ROLLBACK").catch(()=>{});throw err;}finally{client.release();}
}));
app.get("/api/customer-orders",requireAuth,asyncRoute(async(req,res)=>{
 const r=await pool.query("SELECT * FROM customer_orders WHERE shop_id=$1 ORDER BY created_at DESC LIMIT 200",[req.user.shopId]);
 res.json({orders:r.rows.map(customerOrderDto)});
}));
app.put("/api/customer-orders/:id/status",requireAuth,asyncRoute(async(req,res)=>{
 const status=text(req.body.status);
 if(!["accepted","declined","ready","fulfilled","cancelled"].includes(status))throw fail(400,"Choose a valid order status.");
 const client=await pool.connect();
 try{
  await client.query("BEGIN");
  const current=await client.query("SELECT * FROM customer_orders WHERE id=$1 AND shop_id=$2 FOR UPDATE",[req.params.id,req.user.shopId]);
  if(!current.rowCount)throw fail(404,"Order not found.");
  const order=current.rows[0];
  if(!nextOrderStatus(order.status,status))throw fail(409,"Order "+order.reference_code+" is "+ORDER_STATUS_LABELS[order.status]+" and cannot move to "+ORDER_STATUS_LABELS[status]+".");
  const r=await client.query("UPDATE customer_orders SET status=$3,updated_at=NOW() WHERE id=$1 AND shop_id=$2 RETURNING *",[req.params.id,req.user.shopId,status]);
  await client.query("INSERT INTO customer_order_events(id,shop_id,order_id,type,actor,message) VALUES($1,$2,$3,$4,'shop',$5)",[id(),req.user.shopId,order.id,status,orderEventMessage(status,order.reference_code)]);
  const context=await shopContext(req.user.shopId,client);
  const queued=await enqueueOrderEmail(client,context,r.rows[0],status,r.rows[0].customer_email);
  await refreshOrderEmailStatus(client,r.rows[0].id);
  await notify(req.user.shopId,"customer_order","Customer order updated","Order "+order.reference_code+" was marked "+ORDER_STATUS_LABELS[status]+".",{orderId:order.id,status},client);
  const saved=await client.query("SELECT * FROM customer_orders WHERE id=$1",[order.id]);
  await client.query("COMMIT");
  if(queued)scheduleEmailProcessing();
  res.json({ok:true,order:customerOrderDto(saved.rows[0]),emailQueued:queued});
 }catch(err){await client.query("ROLLBACK").catch(()=>{});throw err;}finally{client.release();}
}));

app.use("/api",(req,res)=>res.status(404).json({error:"API endpoint not found."}));
app.use((err,req,res,next)=>{
  if(res.headersSent)return next(err);
  if(isDatabaseError(err)){
    console.error("Database request failed:",err.message);
    return res.status(503).json({error:databaseErrorMessage(),code:"DB_UNAVAILABLE"});
  }
  const status=Number(err.status)||500;if(status>=500)console.error("Request failed:",err);
  res.status(status).json({error:status>=500?"An unexpected server error occurred. Try again or contact support.":err.message});
});

let server;
const timers=[];
const AUTO_PURCHASE_INTERVAL_MS=15*60*1000;
let autoPurchaseRunning=false;
async function scheduledAutoPurchaseCycle(){
  if(autoPurchaseRunning)return;
  autoPurchaseRunning=true;
  try{await runAutoPurchaseCycle();}
  catch(err){console.error("Auto-purchase cycle failed:",err.message);}
  finally{autoPurchaseRunning=false;}
}
async function start(){
  await initializeDatabase();
  await runExpirySweep().catch(err=>console.error("Initial expiry sweep failed:",err.message));
  server=app.listen(PORT,"0.0.0.0",()=>console.log("Easy Gateway listening on port "+PORT));
  timers.push(setInterval(()=>runExpirySweep().catch(err=>console.error("Expiry sweep failed:",err.message)),60000).unref());
  // Settings only persist the auto-purchase policy, so the cycle has to be scheduled here.
  // Shops with automation disabled are skipped by the query inside runAutoPurchaseCycle().
  timers.push(setTimeout(scheduledAutoPurchaseCycle,10000).unref());
  timers.push(setInterval(scheduledAutoPurchaseCycle,AUTO_PURCHASE_INTERVAL_MS).unref());
  // Order confirmations are queued transactionally, then delivered by this worker.
  // Without SMTP_URL or RESEND_API_KEY nothing is claimed and the outbox stays visible as queued.
  timers.push(setTimeout(()=>scheduleEmailProcessing(),8000).unref());
  timers.push(setInterval(()=>scheduleEmailProcessing(),60000).unref());
}
async function shutdown(signal){
  console.log("Received "+signal+"; shutting down gracefully.");
  for(const timer of timers){clearTimeout(timer);clearInterval(timer);}
  if(server)await new Promise(resolve=>server.close(resolve));
  await pool.end();process.exit(0);
}
process.on("SIGTERM",()=>shutdown("SIGTERM"));
process.on("SIGINT",()=>shutdown("SIGINT"));
if(require.main===module)start().catch(err=>{
  console.error("Easy Gateway failed to start:",startupErrorMessage(err));
  if(NODE_ENV!=="production"&&err&&err.stack)console.error(err.stack);
  process.exit(1);
});
module.exports={app,initializeDatabase,runExpirySweep,runAutoPurchaseCycle,calculateDashboard,getPurchasePlan,processEmailOutbox,emailProviderConfig,validDate,validDateRange,dateOnly,isBeforeDate,createQrToken,hashQrToken,isLoopbackHostname,resolvePublicOrigin,qrProductDetails,escapeHtml,generateDemoProduct,publicCustomerProduct,buildStockActions,buildSummaryText,LOYALTY_REWARDS,isDatabaseError,databaseErrorMessage,startupErrorMessage,closeDatabase:()=>pool.end()};
