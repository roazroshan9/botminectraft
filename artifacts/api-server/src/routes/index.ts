import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import botsRouter from "./bots.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/bots", botsRouter as unknown as IRouter);

export default router;
