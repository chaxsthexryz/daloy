import type { ShopifyPayload, ShopifyProductFields } from "@daloy/db";
import { StepError } from "@daloy/engine";

/** The resolved config of a Shopify step: every field is text, a blank one means "not given". */
export type ShopifyCreateInput = { title: string; description: string; price: string; sku: string; status: "draft" | "active"; imageUrl: string };
export type ShopifyUpdateInput = { by: "id" | "sku"; product: string } & Omit<ShopifyCreateInput, "status"> & { status?: "draft" | "active" };
const bad = (message: string) => new StepError(message, false);

/** Reads the text fields into what the Shopify client takes, refusing anything Shopify would round, reject or fetch from the wrong place. */
function fields(i: Partial<ShopifyCreateInput>): ShopifyProductFields {
  const out: ShopifyProductFields = {};
  const title = i.title?.trim();
  if (title !== undefined && title !== "") {
    if (title.length > 255) throw bad("The product title can be at most 255 characters.");
    out.title = title;
  }
  if (i.description !== undefined && i.description.trim() !== "") out.description = i.description.trim().slice(0, 5000);
  const price = i.price?.trim();
  if (price) {
    if (!/^\d{1,10}(\.\d{1,2})?$/.test(price)) throw bad(`The price "${price.slice(0, 30)}" is not valid. Use a number like 499 or 499.50, with no currency sign or commas.`);
    out.price = price;
  }
  const sku = i.sku?.trim();
  if (sku) {
    if (sku.length > 255) throw bad("The SKU can be at most 255 characters.");
    out.sku = sku;
  }
  if (i.status) out.status = i.status;
  const image = i.imageUrl?.trim();
  if (image) {
    let u: URL | undefined;
    try {
      u = new URL(image);
    } catch {
      u = undefined;
    }
    if (!u || u.protocol !== "https:" || u.username || u.password) throw bad("The image link must be a web address that starts with https://.");
    out.imageUrl = image;
  }
  return out;
}

/**
 * The delivery payload of a product step (decision 0105). Bad input fails the step here, before anything is queued. The
 * delivery is pinned to the store connected now, and the worker's delivery loop calls Shopify, retries and holds for review.
 */
export function shopifyPayload(step: "shopify_create_product" | "shopify_update_product", input: ShopifyCreateInput | ShopifyUpdateInput): ShopifyPayload {
  const f = fields(input);
  if (step === "shopify_create_product") {
    if (!f.title) throw bad("The product needs a title.");
    return { shopify: "create", fields: f };
  }
  const u = input as ShopifyUpdateInput;
  if (!u.product.trim()) throw bad("Say which product to update: its id or its SKU.");
  if (Object.keys(f).length === 0) throw bad("Nothing to change: every field is blank.");
  return { shopify: "update", by: u.by, product: u.product.trim(), fields: f };
}
