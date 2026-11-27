// From captures/notice-list/GET-notices.shape.json: a server-rendered page, the only place the notices
// come from (no JSON call carries them), so the values are picked from its HTML.
import { z } from "zod";
import { defineOperation } from "../runtime/operation";

export default defineOperation({
  name: "GET /notices",
  effect: "read",
  rest: { method: "GET", path: "/notices", query: (v) => ({ area: v.area }) },
  html: {
    fields: {
      notices: {
        each: "li.notice",
        in: "ul.notices", // on the page even with no notices, so a new layout is Drift, not an empty list
        fields: {
          id: { css: ":scope", attr: "data-id" },
          title: "h3.title",
          area: "p.area",
          streets: { css: "p.streets", lines: true }, // one street per line, only <br> between them
          startsAt: { css: "p.when time", attr: "datetime" },
          when: "p.when",
        },
      },
    },
  },
  variables: z.object({ area: z.string().min(1).optional() }),
  response: z.object({
    notices: z.array(
      z.object({
        id: z.string().min(1),
        title: z.string().min(1),
        area: z.string().min(1),
        streets: z.array(z.string()),
        startsAt: z.string().nullable(), // a notice that is happening now has no date
        when: z.string().nullable(),
      }),
    ),
  }),
});
