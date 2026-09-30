import { Router } from "express";
import { z } from "zod";
import type { OrderRow } from "../../persistence/orders-repo.js";
import { announceSchema, OrderService, OrderValidationError } from "../../services/order-service.js";
import { cursorSchema, encodeCursor, decodeCursor, validateCursor, type Cursor } from "./cursor-utils.js";

function serialiseOrder(order: OrderRow | null) {
  if (!order) return null;
  return {
    id: order.publicId,
    direction: order.direction,
    status: order.status,
    hashlock: order.hashlock,
    src: {
      chain: order.srcChain,
      address: order.srcAddress,
      asset: order.srcAsset,
      amount: order.srcAmount,
      safetyDeposit: order.srcSafetyDeposit,
      orderId: order.srcOrderId,
      lockTx: order.srcLockTx,
      lockBlock: order.srcLockBlock,
      timelock: order.srcTimelock
    },
    dst: {
      chain: order.dstChain,
      address: order.dstAddress,
      asset: order.dstAsset,
      amount: order.dstAmount,
      orderId: order.dstOrderId,
      lockTx: order.dstLockTx,
      lockBlock: order.dstLockBlock,
      timelock: order.dstTimelock
    },
    secret: {
      revealed: order.preimage !== null,
      preimage: order.preimage,
      revealedTx: order.secretRevealedTx
    },
    resolver: order.resolverAddress,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt
  };
}

export function ordersRoutes(orders: OrderService): Router {
  const router = Router();

  router.post("/orders/announce", async (req, res, next) => {
    try {
      const parsed = announceSchema.parse(req.body);
      const order = await orders.announce(parsed);
      res.status(201).json(serialiseOrder(order));
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json({ error: "validation_error", details: err.errors });
        return;
      }
      if (err instanceof OrderValidationError) {
        res.status(400).json({ error: "order_validation_error", message: err.message });
        return;
      }
      next(err);
    }
  });

  router.get("/orders/:id", async (req, res, next) => {
    const id = req.params.id;
    try {
      const order = await orders.get(id);
      if (!order) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      res.json(serialiseOrder(order));
    } catch (err) {
      next(err);
    }
  });

  router.get("/orders/history", async (req, res, next) => {
    const address = (req.query.address as string | undefined) ?? "";
    if (!address) {
      res.status(400).json({ error: "address_required" });
      return;
    }
    const cursorParam = req.query.cursor as string | undefined;
    let limit = Math.min(Number(req.query.limit ?? 50), 200);
    if (limit < 1) limit = 1;

    let createdAtGreaterThan: number | undefined;
    let createdAtLessThan: number | undefined;

    if (cursorParam) {
      const result = cursorSchema.safeParse({ cursor: cursorParam });
      if (!result.success) {
        res.status(400).json({ error: "invalid_cursor", message: result.error.errors[0].message });
        return;
      }
      const decoded = decodeCursor(cursorParam);
      if (!decoded) {
        res.status(400).json({ error: "invalid_cursor", message: "Failed to decode cursor" });
        return;
      }
      cursor = result.data;
      if (!validateCursor(cursor)) {
        res.status(400).json({ error: "invalid_cursor", message: "Cursor from another user or network" });
        return;
      }
      // For next page (older orders): filter out orders at or before the cursor timestamp
      createdAtLessThan = cursor.createdAt;
    } else {
      cursor = null;
    }

    try {
      const list = await orders.history(address, limit, 0, createdAtGreaterThan, createdAtLessThan);
      const transactions = list.map((o) => serialiseOrder(o)).filter(Boolean);

      // Build next cursor from the last order in the page (oldest order on the page)
      let nextCursor: string | undefined;
      if (transactions.length > 0) {
        const lastOrder = list[list.length - 1];
        nextCursor = encodeCursor(lastOrder.createdAt, lastOrder.publicId);
      }

      res.json({
        transactions,
        pagination: { limit, count: transactions.length, nextCursor }
      });
    } catch (err) {
      next(err);
    }
  });

  const lockSchema = z.object({
    orderId: z.string().min(1),
    txHash: z.string().min(1),
    blockNumber: z.coerce.number().int().nonnegative(),
    timelock: z.coerce.number().int().nonnegative()
  });

  router.post("/orders/:id/src-locked", async (req, res, next) => {
    try {
      const body = lockSchema.parse(req.body);
      await orders.recordSrcLock({ publicId: req.params.id, ...body });
      res.json({ ok: true });
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json({ error: "validation_error", details: err.errors });
        return;
      }
      if (err instanceof OrderValidationError) {
        res.status(400).json({ error: "order_validation_error", message: err.message });
        return;
      }
      next(err);
    }
  });

  router.post("/orders/:id/dst-locked", async (req, res, next) => {
    try {
      const body = lockSchema.extend({ resolver: z.string().nullable().optional() }).parse(req.body);
      await orders.recordDstLock({
        publicId: req.params.id,
        orderId: body.orderId,
        txHash: body.txHash,
        blockNumber: body.blockNumber,
        timelock: body.timelock,
        resolver: body.resolver ?? null
      });
      res.json({ ok: true });
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json({ error: "validation_error", details: err.errors });
        return;
      }
      if (err instanceof OrderValidationError) {
        res.status(400).json({ error: "order_validation_error", message: err.message });
        return;
      }
      next(err);
    }
  });

  return router;
}
