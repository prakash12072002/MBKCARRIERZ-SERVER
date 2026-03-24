import express from "express";
import { parser, uploadMedia } from "../controllers/mediaController.mjs";

const router = express.Router();

router.post("/", parser.single("file"), uploadMedia);

export default router;
