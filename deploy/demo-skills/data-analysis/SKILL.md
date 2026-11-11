---
name: data-analysis
description: Analyze CSV and spreadsheet data, calculate summaries, and create downloadable CSV or XLSX reports. Use for data exploration and quantitative comparisons.
---

# Data analysis

Inspect the supplied columns, row count, missing values, units, and date formats before calculating. Use Python to compute results rather than estimating from a preview. Keep the original inputs intact. Use the standard csv, decimal, and statistics modules for small CSV tasks; use pandas or openpyxl when the requested format needs them, installing a missing library in the sandbox if necessary.

State any assumptions that affect totals. Do not silently treat missing values as zero, mix currencies, or remove duplicate rows without a reason. Check that grouped totals reconcile with the source total. Distinguish an observed correlation from a causal claim.

Create only the requested outputs. For XLSX, use descriptive sheet names, readable column widths, appropriate numeric formats, and an obvious separation between inputs and computed results. Publish final files with persist_artifact and explain the main finding in plain language.

Example: Using sample sales of January 12000, February 15000, and March 18000, calculate the quarter total and month-over-month growth and give me a CSV report. Label the data as sample data.
