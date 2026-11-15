import { z } from "zod";
import { defineCommand } from "../runtime/command";
import listNotices from "../operations/listNotices";

export default defineCommand({
  name: "notice list",
  summary: "Service notices (planned work and outages), optionally for one area",
  args: z.object({ area: z.string().min(1).optional().describe("only notices for this area, as the site names it (Aarhus C)") }),
  uses: [listNotices],
  run: async ({ area }, { call }) => {
    const { notices } = await call(listNotices, { area });
    return {
      notices: notices.map((n) => ({
        id: n.id,
        title: n.title,
        area: n.area.replace(/^Område:\s*/, ""), // the page labels the area
        startsAt: n.startsAt,
        when: n.when,
      })),
    };
  },
});
