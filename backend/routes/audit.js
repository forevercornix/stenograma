const express = require("express");
const auditLog = require("../utils/auditLog");
const auditAuth = require("../middleware/auditAuth");

const router = express.Router();

router.get("/audit", auditAuth, (req, res) => {
  res.json({ entries: auditLog.getAll() });
});

module.exports = router;
