const PIN_KEY = "pushup-phone-pin";
const $ = (id) => document.getElementById(id);

function readPin() {
  try {
    return localStorage.getItem(PIN_KEY) ?? "";
  } catch {
    return "";
  }
}

function savePin(pin) {
  try {
    if (pin) localStorage.setItem(PIN_KEY, pin);
    else localStorage.removeItem(PIN_KEY);
  } catch {}
}

let pin = readPin();
let busy = false;

function say(text, error = false) {
  const el = $("status");
  el.textContent = text;
  el.classList.toggle("error", error);
}

function locked(show) {
  $("pin-form").hidden = !show;
  $("panel").hidden = show;
  $("buttons").hidden = show;
  if (show) $("pin").focus();
}

const PHASES = { active: "In a set", rest: "Resting", ready: "Ready" };

function render(v) {
  $("left").textContent = String(v.left);
  $("phase").textContent = PHASES[v.phase] ?? v.phase ?? "-";
  $("phase").dataset.phase = v.phase ?? "";
  $("set").textContent = `Set ${v.setNumber} - ${v.setReps} reps`;
  $("start").textContent = v.phase === "ready" ? "Start set" : "New set";
  $("finish").disabled = v.phase === "ready";
}

async function call(pathname, options = {}) {
  const res = await fetch(pathname, {
    ...options,
    headers: {
      "X-Pushup-Pin": pin,
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    pin = "";
    savePin("");
    locked(true);
    throw new Error("Wrong PIN");
  }
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

async function refresh() {
  if (!pin || busy) return;
  try {
    render(await call("/api/state"));
    locked(false);
    if ($("status").classList.contains("error")) say("");
  } catch (err) {
    say(
      err.message === "Failed to fetch" ? "Counter offline" : err.message,
      true,
    );
  }
}

$("buttons").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button || busy) return;
  busy = true;
  try {
    const v = await call("/api/control", {
      method: "POST",
      body: JSON.stringify({ action: button.dataset.action }),
    });
    render(v);
    say(button.textContent.trim());
    navigator.vibrate?.(30);
  } catch (err) {
    say(err.message, true);
  } finally {
    busy = false;
  }
});

$("pin-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  pin = $("pin").value.trim();
  $("pin").value = "";
  savePin(pin);
  await refresh();
});

if (pin) refresh();
else locked(true);
setInterval(refresh, 2000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refresh();
});
