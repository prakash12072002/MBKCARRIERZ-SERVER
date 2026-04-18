const express = require("express");
const { authenticate } = require("../../middleware/auth");
const { listTrainersController } = require("./trainers.controller");

const router = express.Router();

router.get("/", authenticate, listTrainersController);

module.exports = router;

