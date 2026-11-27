import { z } from "zod";
import { defineCommand } from "../runtime/command";
import listNotices from "../operations/listNotices";

export default defineCommand({
  name: "notice list",
  summary: "Service notices (planned work and outages), optionally for one area",
  args: z.object({ area: z.string().min(1).optional().describe("only notices for this area, as the site names it (Aarhus C)") }),
  uses: [listNotices],
  output: z.object({
    notices: z.array(
      z.object({
        id: z.string().min(1),
        title: z.string().min(1),
        area: z.string().min(1),
        streets: z.array(z.string()),
        startsAt: z.string().nullable(),
        when: z.string().nullable(),
      }),
    ),
  }),
  run: async ({ area }, { call }) => {
    const { notices } = await call(listNotices, { area });
    return {
      notices: notices.map((n) => ({
        id: n.id,
        title: n.title,
        area: n.area.replace(/^Område:\s*/, ""), // the page labels the area
        streets: n.streets,
        startsAt: n.startsAt,
        when: n.when,
      })),
    };
  },
});
