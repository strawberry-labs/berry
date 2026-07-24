#!/usr/bin/env python3
"""Create a compact AESG workbook from a JSON table specification."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from openpyxl import Workbook
from openpyxl.chart import BarChart, LineChart, PieChart, Reference
from openpyxl.chart.label import DataLabelList
from openpyxl.drawing.image import Image
from openpyxl.formatting.rule import FormulaRule
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.worksheet.table import Table, TableStyleInfo


GREEN = "008C95"
GRAY = "343741"
WHITE = "FFFFFF"
PURPLE = "6D2077"
RED = "DA291C"
YELLOW = "FFC72C"
FONT = "Verdana"


def skill_root() -> Path:
    return Path(__file__).resolve().parents[2]


def normalise_columns(spec: dict) -> list[dict]:
    columns = []
    for item in spec.get("columns", []):
        if isinstance(item, str):
            columns.append({"key": item, "label": item})
        else:
            columns.append(dict(item))
    if not columns:
        raise ValueError("spec.columns must contain at least one column")
    return columns


def chart_for(chart_type: str):
    if chart_type == "line":
        return LineChart()
    if chart_type == "pie":
        return PieChart()
    return BarChart()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--spec", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    if args.output.suffix.casefold() != ".xlsx":
        raise ValueError("--output must end in .xlsx")

    spec = json.loads(args.spec.read_text(encoding="utf-8"))
    columns = normalise_columns(spec)
    rows = spec.get("rows", [])
    workbook = Workbook()
    worksheet = workbook.active
    worksheet.title = str(spec.get("sheet", "Report"))[:31]
    worksheet.sheet_view.showGridLines = False
    worksheet.freeze_panes = "A4"

    logo_path = skill_root() / "aesg-branding/assets/extracted/aesg-logo-primary.jpg"
    if logo_path.is_file():
        logo = Image(logo_path)
        logo.width = 174
        logo.height = 50
        worksheet.add_image(logo, "A1")
    worksheet.row_dimensions[1].height = 42

    last_column = get_column_letter(len(columns))
    worksheet.merge_cells(f"A2:{last_column}2")
    title = worksheet["A2"]
    title.value = str(spec.get("title", "AESG Workbook"))
    title.fill = PatternFill("solid", fgColor=GREEN)
    title.font = Font(name=FONT, size=14, bold=True, color=WHITE)
    title.alignment = Alignment(horizontal="center", vertical="center")
    worksheet.row_dimensions[2].height = 30

    thin_gray = Side(style="thin", color="D9D9D9")
    for column_index, column in enumerate(columns, start=1):
        cell = worksheet.cell(3, column_index, str(column.get("label", column["key"])))
        cell.fill = PatternFill("solid", fgColor=GRAY)
        cell.font = Font(name=FONT, size=10, bold=True, color=WHITE)
        cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
        cell.border = Border(bottom=thin_gray)
        worksheet.column_dimensions[get_column_letter(column_index)].width = float(column.get("width", 18))
    worksheet.row_dimensions[3].height = 24.75

    for row_index, row in enumerate(rows, start=4):
        for column_index, column in enumerate(columns, start=1):
            key = str(column["key"])
            value = row.get(key, "") if isinstance(row, dict) else row[column_index - 1]
            cell = worksheet.cell(row_index, column_index, value)
            cell.font = Font(name=FONT, size=9, color=GRAY)
            cell.alignment = Alignment(
                horizontal="right" if isinstance(value, (int, float)) else "left",
                vertical="center",
                wrap_text=True,
            )
            cell.border = Border(bottom=thin_gray)
            if column.get("format"):
                cell.number_format = str(column["format"])
        worksheet.row_dimensions[row_index].height = 19.5

    end_row = max(4, 3 + len(rows))
    if rows:
        table = Table(displayName="AESGData", ref=f"A3:{last_column}{end_row}")
        table.tableStyleInfo = TableStyleInfo(
            name="TableStyleMedium2",
            showFirstColumn=False,
            showLastColumn=False,
            showRowStripes=False,
            showColumnStripes=False,
        )
        worksheet.add_table(table)

    for column_index, column in enumerate(columns, start=1):
        values = column.get("validation")
        if values:
            quoted = '"' + ",".join(str(value) for value in values) + '"'
            validation = DataValidation(type="list", formula1=quoted, allow_blank=True)
            worksheet.add_data_validation(validation)
            validation.add(f"{get_column_letter(column_index)}4:{get_column_letter(column_index)}{max(end_row, 200)}")
        if str(column.get("key", "")).casefold() == "status":
            column_letter = get_column_letter(column_index)
            worksheet.conditional_formatting.add(
                f"{column_letter}4:{column_letter}{max(end_row, 200)}",
                FormulaRule(
                    formula=[f'LOWER({column_letter}4)="at risk"'],
                    fill=PatternFill("solid", fgColor="F9DDD9"),
                    font=Font(name=FONT, color=RED),
                ),
            )

    chart_spec = spec.get("chart")
    print_last_column = len(columns)
    print_last_row = end_row
    if chart_spec and rows:
        keys = [str(column["key"]) for column in columns]
        category_index = keys.index(str(chart_spec["category"])) + 1
        value_index = keys.index(str(chart_spec["value"])) + 1
        chart = chart_for(str(chart_spec.get("type", "bar")).casefold())
        chart.title = str(chart_spec.get("title", ""))
        chart.style = 10
        chart.height = 7
        chart.width = 12
        categories = Reference(worksheet, min_col=category_index, min_row=4, max_row=end_row)
        values = Reference(worksheet, min_col=value_index, min_row=3, max_row=end_row)
        chart.add_data(values, titles_from_data=True)
        chart.set_categories(categories)
        if chart.series:
            chart.series[0].graphicalProperties.solidFill = GREEN
            chart.series[0].graphicalProperties.line.solidFill = GREEN
        if isinstance(chart, PieChart):
            chart.dataLabels = DataLabelList()
            chart.dataLabels.showPercent = True
        anchor = f"A{end_row + 2}"
        worksheet.add_chart(chart, anchor)
        print_last_column = max(len(columns), 8)
        print_last_row = end_row + 18

    worksheet.auto_filter.ref = f"A3:{last_column}{end_row}"
    worksheet.print_area = (
        f"A1:{get_column_letter(print_last_column)}{print_last_row}"
    )
    worksheet.page_setup.paperSize = worksheet.PAPERSIZE_A4
    worksheet.page_setup.orientation = "portrait"
    worksheet.page_setup.fitToWidth = 1
    worksheet.page_setup.fitToHeight = 0
    worksheet.sheet_properties.pageSetUpPr.fitToPage = True
    worksheet.oddFooter.center.text = "AESG | &P of &N"
    worksheet.oddFooter.center.font = f"{FONT},Regular"
    worksheet.oddFooter.center.size = 7
    workbook.calculation.fullCalcOnLoad = True
    workbook.calculation.forceFullCalc = True
    workbook.calculation.calcMode = "auto"

    args.output.parent.mkdir(parents=True, exist_ok=True)
    workbook.save(args.output)
    print(json.dumps({"ok": True, "output": str(args.output.resolve()), "bytes": args.output.stat().st_size}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
