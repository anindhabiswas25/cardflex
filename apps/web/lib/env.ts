// Runtime configuration (public: these are endpoints, never secrets).
import { ENDPOINTS } from "@card-flex/client-sdk";

export const BASE_RPC = process.env.NEXT_PUBLIC_BASE_RPC ?? ENDPOINTS.devnet.base;
export const PER_RPC = process.env.NEXT_PUBLIC_PER_RPC ?? ENDPOINTS.devnet.per;
/** The read-only indexer API (services/api). History pages degrade gracefully without it. */
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:4000";
export const CLUSTER = "devnet" as const;
