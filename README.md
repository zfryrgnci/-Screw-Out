# 🔩 Screw Out

**Layered plank puzzler — unscrew what you can reach.**

---

## About

One rendering fact does all the work: planks are painted in layer order, so a screw is **visible exactly when no higher plank covers its hole** — which is the same condition as being turnable.

Occlusion is not drawn to illustrate the rule, it *is* the rule. What the player sees can never disagree with what the engine allows.

---

## Tech

| | |
|---|---|
| Language | `Kotlin` |
| Rendering | `HTML5 Canvas` — one canvas, nothing layered over it |
| Shell | Native Android `WebView` |
| Ads | Google Mobile Ads SDK (interstitial + rewarded) |
| Package | `com.refaz.screwout` |
| Min / Target SDK | 24 / 36 |

**One canvas, nothing on top of it** — that is deliberate across this whole
portfolio. A sibling game once shipped completely unplayable because an invisible
positioned element sat over the canvas and swallowed every tap, while its entire
test suite passed. If the only thing the player can touch is the canvas, that
failure cannot happen.
