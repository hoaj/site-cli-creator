// Shared output shape of the deal commands (shared command code lives in src/lib/).
import type { z } from "zod";
import type searchSuppliers from "../operations/searchSuppliers";

type Item = z.infer<typeof searchSuppliers.response>["results"]["items"][number];

export const shopUrl = (id: number) => `https://www.mylogbuy.com/partner/${id}`;

export const toDeal = (i: Item) => ({
  shop: i.title,
  shopId: i.supplierId,
  discount: i.discount,
  minPercent: i.discountInfo.minPercent,
  maxPercent: i.discountInfo.maxPercent,
  description: i.description,
  offer: i.specialOffer && { title: i.specialOffer.punchline, detail: i.specialOffer.detail, timeLeft: i.specialOffer.timeLeft },
  url: shopUrl(i.supplierId),
});
