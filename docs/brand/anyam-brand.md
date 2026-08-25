# Anyam brand system

This is the normative visual language for Anyam's source-control, delivery,
agent, CLI, and customer-owned Realm surfaces. The supplied board is preserved
in [assets/anyam-brand-board.png](./assets/anyam-brand-board.png); optimized
working assets sit beside it.

## Core idea

Anyam's mark is a single continuous, interwoven path. It represents separate
human and agent changes becoming one verifiable delivery path. The product name
is written as **Anyam** with a capital A and lowercase remainder.

Use the wordmark for product identity and the mark alone for compact contexts
such as favicons, app icons, navigation, and status surfaces.

## Color tokens

These values come directly from the supplied kit:

| Token | Hex | Use |
| --- | --- | --- |
| Ink | #0A0A0A | Primary text, dark surfaces, monochrome mark |
| Slate | #6B7280 | Secondary text, metadata, quiet borders |
| Mist | #F2F4F7 | Light page background and soft panels |
| Accent Blue | #2563EB | Primary action, links, focus indication, app icon field |
| White | #FFFFFF | Inverse mark, inverse text, light surfaces |

The executable tokens live in src/brand.ts. UI code must use those tokens
instead of adding a one-off color. Dark surfaces use Ink as the base and
White/Mist for readable foregrounds. Accent Blue remains the action color;
buttons must use White text on the blue field.

## Typography

The kit uses a clean geometric sans wordmark. Product UI uses the local/system
sans stack Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont,
"Segoe UI", sans-serif, with no remote font dependency. Receipts, hashes,
identifiers, and command output use a platform monospace stack.

Do not use the wordmark as a body font. Keep the wordmark's tight tracking and
medium weight only for the brand lockup.

## Mark and lockup

- Use the supplied mark without stretching, rotating, outlining, or adding
  effects.
- Use the black mark on light surfaces and the inverse/filtered mark on dark
  surfaces.
- Use the lockup when the user needs product orientation; use the mark alone
  when the surrounding navigation already says Anyam.
- Preserve clear space equal to the height of the mark's inner loop on every
  side. This is a minimum, not a target to fill.
- Never place the mark inside a status badge, merge icon, or provider logo.

The Worker surfaces inline a small optimized transparent mark so a
customer-owned Realm does not depend on an external asset host. The source
assets remain available for the future control-room frontend and release
documentation.

## Surfaces

The system has two approved modes:

### Light

Mist page background, White cards, Ink text, Slate metadata, and Accent Blue
actions.

### Dark

Ink page background, near-Ink cards, Mist/White text, Slate-derived metadata,
and Accent Blue actions. Inverse the black mark with the shared brand class.

Use a single mode per surface. Do not mix a dark card into a light page merely
for decoration.

## Interaction and accessibility

- Accent Blue is the only primary action color.
- Every focusable control keeps a visible focus ring derived from Accent Blue.
- Disabled controls reduce opacity and retain their label; never communicate
  disabled state by color alone.
- Receipts and failure details remain readable, selectable, and
  overflow-wrap:anywhere.
- Brand imagery has an empty alt attribute when adjacent text says Anyam, and a
  meaningful alt text when the mark is the only product label.
- The brand system does not replace state colors. Health, failure, and warning
  states must remain semantically labeled in text and must meet contrast
  requirements independently.

## Applying the system

Import ANYAM_BRAND_CSS, anyamBrandStyleTag, and anyamBrandLockup from
src/brand.ts for server-rendered HTML. The same CSS custom properties are the
contract for the future control-room frontend, CLI-generated web surfaces, and
customer Realm templates.

Any change to palette, type, logo usage, or clear-space rules must update this
document and the executable tokens together. A brand change without a source
receipt is a landmine: it will drift across customer-owned installations.
