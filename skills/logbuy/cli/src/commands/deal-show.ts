import { z } from "zod";
import { defineCommand, inputFailure } from "../runtime/command";
import searchSuppliers from "../operations/searchSuppliers";
import { shopUrl } from "../lib/deals";

export default defineCommand({
  name: "deal show",
  summary: "One shop's LogBuy deal in full: discount, terms, current offer, link",
  args: z.object({ shop: z.string().min(1).describe("the shop's name, as `deal search` lists it") }),
  uses: [searchSuppliers],
  run: async ({ shop }, { call }) => {
    const r = await call(searchSuppliers, { query: shop, limit: 25, sortBy: "BestMatch" });
    const want = shop.trim().toLowerCase();
    const i = r.results.items.find((x) => x.title.trim().toLowerCase() === want);
    if (!i) {
      const close = r.results.items.slice(0, 5).map((x) => x.title);
      inputFailure(close.length
        ? `No shop named exactly "${shop}". Close matches: ${close.join(", ")}. Rerun with one of them.`
        : `No shop matches "${shop}": run \`deal search --query <text>\` to find its name.`);
    }
    return {
      shop: i.title,
      shopId: i.supplierId,
      discount: i.discount,
      minPercent: i.discountInfo.minPercent,
      maxPercent: i.discountInfo.maxPercent,
      description: i.description,
      about: i.about,
      offer: i.specialOffer && {
        title: i.specialOffer.punchline,
        detail: i.specialOffer.detail,
        discount: i.specialOffer.discount,
        timeLeft: i.specialOffer.timeLeft,
      },
      addresses: i.numberOfAddresses,
      url: shopUrl(i.supplierId),
    };
  },
});
