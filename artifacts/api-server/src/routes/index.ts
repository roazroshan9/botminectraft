import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import botsRouter from "./bots.js";
import authRouter from "./auth.js";
import userBotsRouter from "./user-bots.js";
import adminRouter from "./admin.js";
import adminAuthRouter from "./admin-auth.js";

const router: IRouter = Router();

router.use("/auth", authRouter as unknown as IRouter);
router.use(healthRouter);
router.use("/bots", botsRouter as unknown as IRouter);
router.use("/user", userBotsRouter as unknown as IRouter);
router.use("/admin", adminRouter as unknown as IRouter);
router.use("/admin-auth", adminAuthRouter as unknown as IRouter);

export default router;
