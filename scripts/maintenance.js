const {
  initializeDatabase,
  runExpirySweep,
  runAutoPurchaseCycle,
  closeDatabase
} = require("../server");

(async () => {
  try {
    await initializeDatabase();
    const expiredCount = await runExpirySweep();
    await runAutoPurchaseCycle();
    console.log("Easy Gateway maintenance completed. Expired products moved: " + expiredCount);
  } catch (error) {
    console.error("Easy Gateway maintenance failed:", error);
    process.exitCode = 1;
  } finally {
    await closeDatabase().catch(() => {});
  }
})();
