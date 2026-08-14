# AESG General Presentation layout catalog

## Approved generator layouts

Use only these semantic names. Each one clones a visible specimen slide, so
the inherited master/layout chain and local artwork remain intact.

| Semantic layout | Specimen | Content fields | Image rule | Per-block capacity |
|---|---:|---|---|---:|
| `cover` | 1 | `title`, `subtitle`, `client`, `date` | None | Title 90 characters |
| `text` | 2 | `title`, `section`, `body` | None | 1,800 characters |
| `two_columns` | 3 | `title`, `section`, `columns[2]` | None | 850 characters |
| `three_columns` | 4 | `title`, `section`, `columns[3]` | None | 540 characters |
| `five_images` | 5 | `title`, `body` | One to five required | 760 characters |
| `image_statement` | 6 | `title`, `section`, `body` | One required | 1,000 characters |
| `image_bottom` | 7 | `title`, `section`, `body` | One required | 650 characters |
| `text_image` | 8 | `title`, `section`, `body` | One required, right | 700 characters |
| `image_text` | 9 | `title`, `section`, `body` | One required, left | 700 characters |
| `divider` | 10 | `title` | None | Title 90 characters |
| `gallery` | 11 | `items[3]` | One to nine required | 420 characters |
| `image_three_columns` | 12 | `columns[3]` | One required, top | 360 characters |
| `three_columns_image` | 13 | `columns[3]` | One required, bottom | 360 characters |
| `image_two_columns` | 15 | `columns[2]` | One required, top | 520 characters |
| `statement` | 16 | `title`, `body` | None | 1,000 characters |
| `plain` | 16 | `title`, `body` | None | 1,500 characters |
| `closing` | 17 | None | None | Uses retained office contacts |

Values in `body`, `columns`, or `items` may be strings, arrays of strings, or
objects with `title`, `body`, and `bullets`.

`gallery`, `image_three_columns`, `three_columns_image`, and
`image_two_columns` are titleless specimens. Passing `title` or `section` to
them is an error. The organisation-chart specimen at slide 14 remains in the
runtime as reference-only content because its labels are inherited and are not
safe editable slide-local shapes.

## Compact runtime inventory

The repaired source contained 2 masters and 59 layouts. The committed runtime
keeps one master and the 17 layouts reached by the approved specimen slides.
Pruning is lossless: all 17 specimen renders remain pixel-identical while the
unused sector covers, back covers, Office master, and their media are removed.

| Specimen | Retained layout | Generator route |
|---:|---|---|
| 1 | `Cover Buildings` | `cover` |
| 2 | `Custom Layout` | `text` |
| 3 | `7_Custom Layout` | `two_columns` |
| 4 | `28_Custom Layout` | `three_columns` |
| 5 | `31_Custom Layout` | `five_images` |
| 6 | `5_Custom Layout` | `image_statement` |
| 7 | `19_Custom Layout` | `image_bottom` |
| 8 | `12_Custom Layout` | `text_image` |
| 9 | `13_Custom Layout` | `image_text` |
| 10 | `Divider Buildings` | `divider` |
| 11 | `7_DEFAULT` | `gallery` |
| 12 | `11_DEFAULT` | `image_three_columns` |
| 13 | `12_DEFAULT` | `three_columns_image` |
| 14 | `14_DEFAULT` | Reference-only organisation chart |
| 15 | `16_DEFAULT` | `image_two_columns` |
| 16 | `30_Custom Layout` | `statement`, `plain` |
| 17 | `Back Cover All Countries` | `closing` |

Use `compact_pptx_template.py` only when rebuilding the runtime asset from an
audited, repaired source. Do not run it on generated client decks.
