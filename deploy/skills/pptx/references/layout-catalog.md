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
| `statement` | 6 | `title`, `section`, `body` | None | 1,000 characters |
| `image_bottom` | 7 | `title`, `section`, `body` | One required | 650 characters |
| `text_image` | 8 | `title`, `section`, `body` | One required, right | 700 characters |
| `image_text` | 9 | `title`, `section`, `body` | One required, left | 700 characters |
| `divider` | 10 | `title` | None | Title 90 characters |
| `gallery` | 11 | `title`, `section`, `columns[3]` | One to nine required | 420 characters |
| `image_three_columns` | 12 | `title`, `section`, `columns[3]` | One required, top | 360 characters |
| `three_columns_image` | 13 | `title`, `section`, `columns[3]` | One required, bottom | 360 characters |
| `image_two_columns` | 15 | `title`, `section`, `columns[2]` | One required, top | 520 characters |
| `plain` | 16 | `title`, `section`, `body` | None | 1,500 characters |
| `closing` | 17 | None | None | Uses retained office contacts |

Values in `body`, `columns`, or `items` may be strings, arrays of strings, or
objects with `title`, `body`, and `bullets`.

The five-circle specimen and organisation-chart specimen remain in the source
template but are not generator routes. Their visible labels live on layouts,
not safely editable slide-local shapes.

## Master inventory

The repaired runtime template contains two masters and 59 layouts.

### Master 1: AESG General Template (47 layouts)

1. Cover Buildings
2. 7_Custom Layout
3. 28_Custom Layout
4. 31_Custom Layout
5. 5_Custom Layout
6. 6_Custom Layout
7. 19_Custom Layout
8. 11_Custom Layout
9. 12_Custom Layout
10. 13_Custom Layout
11. 8_Custom Layout
12. Cover Data Centers
13. 10_Custom Layout
14. 9_Custom Layout
15. 14_Custom Layout
16. 20_Custom Layout
17. 15_Custom Layout
18. 16_Custom Layout
19. 17_Custom Layout
20. 18_Custom Layout
21. 5_DEFAULT
22. 18_DEFAULT
23. Cover Industrial
24. 17_DEFAULT
25. 13_DEFAULT
26. 7_DEFAULT
27. 15_DEFAULT
28. 11_DEFAULT
29. 12_DEFAULT
30. 6_DEFAULT
31. 14_DEFAULT
32. 16_DEFAULT
33. 29_Custom Layout
34. Cover Logistics
35. 30_Custom Layout
36. Back Cover UAE
37. Back Cover KSA
38. Back Cover UK
39. Back Cover Singapore
40. Back Cover South Africa
41. Back Cover Australia
42. Back Cover All Countries
43. Divider Buildings
44. Divider Data Centers
45. Divider Industrial
46. Divider Logistics
47. Custom Layout

### Master 2: unclassified Office master (12 layouts)

1. Title Slide
2. Picture with Caption
3. Title and Vertical Text
4. Vertical Title and Text
5. Title and Content
6. 1_Title and Content
7. Section Header
8. Two Content
9. Comparison
10. Title Only
11. Blank
12. Content with Caption

Do not route generated content through Master 2 until a separately rendered
specimen deck confirms its inherited branding and editable placeholder map.
