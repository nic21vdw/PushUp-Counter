/**
 * Draws the end-of-stream recap onto a 2D canvas. The page and the PNG
 * export use the same function, so the file people post is the card OBS
 * showed.
 *
 * `layout: "wide"` is 1920x1080 (the OBS source and a 16:9 PNG), `"tall"` is
 * 1080x1350 (a 4:5 social post). `backdrop: false` leaves everything outside
 * the card transparent, for OBS.
 */

const COLORS = {
  plate: "rgba(8, 11, 14, 0.86)",
  line: "rgba(255, 255, 255, 0.12)",
  text: "#ffffff",
  muted: "#9aa8b8",
  cyan: "#3ddcff",
  violet: "#7c5cff",
  gold: "#ffd23f",
  green: "#4ade80",
  tile: "rgba(255, 255, 255, 0.05)",
};
const FONT = '"Inter", "Helvetica Neue", Arial, sans-serif';

export const SIZES = {
  wide: { width: 1920, height: 1080 },
  tall: { width: 1080, height: 1350 },
};

const font = (size, weight = 600) => `${weight} ${size}px ${FONT}`;

export function formatDuration(ms) {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}

export function formatDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

const clock = (ms) =>
  new Date(ms).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function text(ctx, value, x, y, { size, weight, color, align = "left" }) {
  ctx.font = font(size, weight);
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = "alphabetic";
  ctx.fillText(String(value), x, y);
}

function fit(ctx, value, maxWidth, size, weight) {
  let s = size;
  ctx.font = font(s, weight);
  while (s > 12 && ctx.measureText(String(value)).width > maxWidth) {
    s -= 2;
    ctx.font = font(s, weight);
  }
  return s;
}

function kicker(ctx, label, x, y, size) {
  ctx.save();
  ctx.letterSpacing = `${Math.round(size * 0.16)}px`;
  text(ctx, label.toUpperCase(), x, y, {
    size,
    weight: 800,
    color: COLORS.cyan,
  });
  ctx.restore();
}

function tile(ctx, x, y, w, h, { label, value, sub, accent }, scale) {
  roundRect(ctx, x, y, w, h, 18 * scale);
  ctx.fillStyle = COLORS.tile;
  ctx.fill();
  ctx.strokeStyle = COLORS.line;
  ctx.lineWidth = 2;
  ctx.stroke();
  const pad = 22 * scale;
  ctx.save();
  ctx.letterSpacing = `${Math.round(3 * scale)}px`;
  text(ctx, label.toUpperCase(), x + pad, y + pad + 18 * scale, {
    size: 19 * scale,
    weight: 700,
    color: COLORS.muted,
  });
  ctx.restore();
  ctx.font = font(20 * scale, 500);
  const subW = sub ? ctx.measureText(sub).width + 14 * scale : 0;
  const room = h - pad * 2 - 26 * scale;
  const valueSize = fit(
    ctx,
    value,
    w - pad * 2 - subW,
    Math.min(60 * scale, room / 0.74),
    800,
  );
  text(ctx, value, x + pad, y + h - pad, {
    size: valueSize,
    weight: 800,
    color: accent ?? COLORS.text,
  });
  if (sub)
    text(ctx, sub, x + w - pad, y + h - pad, {
      size: 20 * scale,
      weight: 500,
      color: COLORS.muted,
      align: "right",
    });
}

function chart(ctx, recap, x, y, w, h, scale) {
  kicker(ctx, "Push-ups per hour", x, y + 22 * scale, 22 * scale);
  const top = y + 56 * scale;
  const labelH = 34 * scale;
  const valueH = 34 * scale;
  const plotH = h - (top - y) - labelH;
  const bars = recap.perHour;
  const max = Math.max(1, ...bars.map((b) => b.reps));
  const gap = Math.max(4, Math.min(18 * scale, (w / bars.length) * 0.22));
  const barW = Math.min(
    240 * scale,
    (w - gap * (bars.length - 1)) / bars.length,
  );
  const start = Date.parse(recap.startedAt);
  const every = Math.ceil(bars.length / 12);

  ctx.strokeStyle = COLORS.line;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, top + plotH);
  ctx.lineTo(x + w, top + plotH);
  ctx.stroke();

  if (bars.every((b) => b.reps === 0)) {
    text(ctx, "No push-ups logged yet", x + w / 2, top + plotH / 2, {
      size: 28 * scale,
      weight: 600,
      color: COLORS.muted,
      align: "center",
    });
  }

  const peak = bars.reduce(
    (best, b) => (b.reps > best.reps ? b : best),
    bars[0],
  );
  bars.forEach((b, i) => {
    const bx = x + i * (barW + gap);
    const bh = b.reps > 0 ? Math.max(6, ((plotH - valueH) * b.reps) / max) : 0;
    const by = top + plotH - bh;
    if (bh > 0) {
      const grad = ctx.createLinearGradient(0, by, 0, top + plotH);
      const hot = b === peak;
      grad.addColorStop(0, hot ? COLORS.gold : COLORS.cyan);
      grad.addColorStop(
        1,
        hot ? "rgba(255,138,31,0.55)" : "rgba(124,92,255,0.55)",
      );
      roundRect(ctx, bx, by, barW, bh, Math.min(10 * scale, barW / 2));
      ctx.fillStyle = grad;
      ctx.fill();
      if (barW >= 26 * scale)
        text(ctx, b.reps, bx + barW / 2, by - 10 * scale, {
          size: Math.min(26 * scale, barW * 0.6),
          weight: 800,
          color: COLORS.text,
          align: "center",
        });
    }
    if (i % every === 0)
      text(
        ctx,
        clock(start + b.hour * 3_600_000),
        bx + barW / 2,
        top + plotH + 28 * scale,
        {
          size: Math.min(19 * scale, barW * 0.55 + 8),
          weight: 600,
          color: COLORS.muted,
          align: "center",
        },
      );
  });
}

function contributors(ctx, recap, x, y, w, h, scale) {
  kicker(ctx, "Top contributors", x, y + 22 * scale, 22 * scale);
  const colGap = 32 * scale;
  const colW = (w - colGap) / 2;
  const rowH = 40 * scale;
  let rowY = y + 70 * scale;

  const left = recap.contributors.available
    ? {
        title: "Subscribers",
        rows: recap.contributors.names.map((n) => ({
          label: n.name,
          value: n.subs,
          valueText: `${n.subs}`,
        })),
      }
    : {
        title: "Where the reps came from",
        rows: recap.sources.map((s) => ({
          label: s.label,
          value: s.reps,
          valueText: `${s.reps}`,
        })),
      };
  const right = {
    title: recap.subsEnabled ? "Biggest sub bursts" : "Subscribers",
    rows: recap.subBursts.map((b) => ({
      label: clock(Date.parse(b.at)),
      value: b.delta,
      valueText: `+${b.delta} sub${b.delta === 1 ? "" : "s"}`,
    })),
    empty: recap.subsEnabled ? "No new subs logged" : "Sub counting was off",
  };

  for (const [i, col] of [left, right].entries()) {
    const cx = x + i * (colW + colGap);
    text(ctx, col.title, cx, rowY, {
      size: 21 * scale,
      weight: 700,
      color: COLORS.muted,
    });
    const max = Math.max(1, ...col.rows.map((r) => r.value));
    const fitRows = Math.max(1, Math.floor((h - 110 * scale) / rowH));
    const rows = col.rows.slice(0, Math.min(4, fitRows));
    if (rows.length === 0)
      text(ctx, col.empty ?? "Nothing logged yet", cx, rowY + rowH, {
        size: 22 * scale,
        weight: 500,
        color: COLORS.muted,
      });
    rows.forEach((r, j) => {
      const ry = rowY + (j + 1) * rowH;
      const barMax = colW * 0.42;
      const bw = Math.max(8, (barMax * r.value) / max);
      roundRect(ctx, cx, ry - 18 * scale, bw, 20 * scale, 6 * scale);
      ctx.fillStyle = i === 0 ? COLORS.cyan : COLORS.green;
      ctx.fill();
      const labelSize = fit(
        ctx,
        r.label,
        colW - barMax - 130 * scale,
        22 * scale,
        600,
      );
      text(ctx, r.label, cx + barMax + 16 * scale, ry, {
        size: labelSize,
        weight: 600,
        color: COLORS.text,
      });
      text(ctx, r.valueText, cx + colW, ry, {
        size: 22 * scale,
        weight: 800,
        color: COLORS.text,
        align: "right",
      });
    });
  }

  if (!recap.contributors.available) {
    const note =
      "Subscriber names are not in the feeds this counter reads, so this shows where reps and subs came from.";
    text(ctx, note, x, y + h - 4 * scale, {
      size: fit(ctx, note, w, 17 * scale, 500),
      weight: 500,
      color: COLORS.muted,
    });
  }
}

function correctionsLine(recap) {
  const c = recap.corrections;
  const parts = [];
  if (c["chat-correction"])
    parts.push(
      `${c["chat-correction"]} chat fix${c["chat-correction"] === 1 ? "" : "es"}`,
    );
  const hand = c["manual-plus"] + c["manual-minus"];
  if (hand) parts.push(`${hand} by hand`);
  if (c.undo) parts.push(`${c.undo} undo${c.undo === 1 ? "" : "s"}`);
  if (c["reset-set"])
    parts.push(`${c["reset-set"]} set reset${c["reset-set"] === 1 ? "" : "s"}`);
  return parts.length
    ? `Corrections: ${parts.join(", ")}`
    : "No corrections needed";
}

function tiles(recap) {
  const best = recap.bestSet;
  return [
    {
      label: "Best set",
      value: best ? `${best.reps}` : "-",
      sub: best ? `set ${best.set}` : "no sets yet",
      accent: COLORS.gold,
    },
    {
      label: "Sets",
      value: `${recap.setCount}`,
      sub: recap.setCount
        ? `${Math.round(recap.total / Math.max(1, recap.setCount))} avg`
        : " ",
    },
    {
      label: "Subs gained",
      value: recap.subsEnabled ? `+${recap.subsGained}` : "off",
      sub: recap.subsEnabled ? "this stream" : "not counted",
      accent: COLORS.green,
    },
    {
      label: "Best streak",
      value: `${recap.bestStreak}`,
      sub: "reps in a row",
    },
  ];
}

function header(ctx, recap, x, y, w, scale) {
  kicker(
    ctx,
    recap.live ? "Stream recap - live" : "Stream recap",
    x,
    y + 26 * scale,
    26 * scale,
  );
  text(
    ctx,
    `${formatDate(recap.startedAt)}  ·  ${formatDuration(recap.durationMs)}`,
    x + w,
    y + 26 * scale,
    { size: 26 * scale, weight: 600, color: COLORS.muted, align: "right" },
  );
}

function total(ctx, recap, x, y, w, scale, size) {
  ctx.save();
  ctx.shadowColor = "rgba(61, 220, 255, 0.45)";
  ctx.shadowBlur = 40 * scale;
  const s = fit(ctx, recap.total, w, size, 900);
  text(ctx, recap.total, x, y + s * 0.78, {
    size: s,
    weight: 900,
    color: COLORS.text,
  });
  ctx.restore();
  text(
    ctx,
    recap.total === 1 ? "push-up" : "push-ups",
    x,
    y + s * 0.78 + 56 * scale,
    {
      size: 44 * scale,
      weight: 700,
      color: COLORS.muted,
    },
  );
  return s * 0.78 + 56 * scale;
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} recap from `buildRecap`
 * @param {{layout?: "wide"|"tall", backdrop?: boolean}} [opts]
 */
export function drawRecapCard(
  ctx,
  recap,
  { layout = "wide", backdrop = false } = {},
) {
  const { width, height } = SIZES[layout];
  ctx.clearRect(0, 0, width, height);
  if (backdrop) {
    const bg = ctx.createLinearGradient(0, 0, width, height);
    bg.addColorStop(0, "#0b0f15");
    bg.addColorStop(1, "#1a1036");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, width, height);
  }

  const margin = layout === "wide" ? 60 : 40;
  const cardX = margin;
  const cardY = margin;
  const cardW = width - margin * 2;
  const cardH = height - margin * 2;
  ctx.save();
  ctx.shadowColor = "rgba(61, 220, 255, 0.22)";
  ctx.shadowBlur = 40;
  roundRect(ctx, cardX, cardY, cardW, cardH, 32);
  ctx.fillStyle = COLORS.plate;
  ctx.fill();
  ctx.restore();
  roundRect(ctx, cardX, cardY, cardW, cardH, 32);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.16)";
  ctx.lineWidth = 2;
  ctx.stroke();

  const pad = layout === "wide" ? 56 : 48;
  const x = cardX + pad;
  const y = cardY + pad;
  const w = cardW - pad * 2;
  const scale = 1;
  header(ctx, recap, x, y, w, scale);

  if (layout === "wide") {
    const leftW = 640;
    const used = total(ctx, recap, x, y + 60, leftW, scale, 230);
    const tileY = y + 60 + used + 40;
    const tileGap = 20;
    const tileW = (leftW - tileGap) / 2;
    const tileH = 150;
    tiles(recap).forEach((t, i) =>
      tile(
        ctx,
        x + (i % 2) * (tileW + tileGap),
        tileY + Math.floor(i / 2) * (tileH + tileGap),
        tileW,
        tileH,
        t,
        scale,
      ),
    );
    text(ctx, correctionsLine(recap), x, cardY + cardH - pad, {
      size: 21,
      weight: 500,
      color: COLORS.muted,
    });
    const rx = x + leftW + 70;
    const rw = x + w - rx;
    chart(ctx, recap, rx, y + 70, rw, 420, scale);
    contributors(
      ctx,
      recap,
      rx,
      y + 540,
      rw,
      cardY + cardH - pad - (y + 540),
      scale,
    );
  } else {
    const used = total(ctx, recap, x, y + 64, w, scale, 170);
    const tileY = y + 64 + used + 30;
    const tileGap = 18;
    const tileW = (w - tileGap) / 2;
    const tileH = 120;
    tiles(recap).forEach((t, i) =>
      tile(
        ctx,
        x + (i % 2) * (tileW + tileGap),
        tileY + Math.floor(i / 2) * (tileH + tileGap),
        tileW,
        tileH,
        t,
        scale,
      ),
    );
    const chartY = tileY + tileH * 2 + tileGap + 40;
    chart(ctx, recap, x, chartY, w, 280, scale);
    const contribY = chartY + 310;
    contributors(
      ctx,
      recap,
      x,
      contribY,
      w,
      cardY + cardH - pad - 30 - contribY,
      scale,
    );
    text(ctx, correctionsLine(recap), x, cardY + cardH - pad, {
      size: 20,
      weight: 500,
      color: COLORS.muted,
    });
  }
}
