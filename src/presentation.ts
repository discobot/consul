/** Return cell-index rows that fit a prefixed terminal line at the requested width. */
export function packCellRows(prefixWidth: number, cellWidths: number[], width: number): number[][] {
	width = Math.max(1, width);
	const indent = Math.min(Math.max(0, prefixWidth), Math.max(0, width - 1));
	const rows: number[][] = [];
	let row: number[] = [];
	let used = prefixWidth;
	for (let index = 0; index < cellWidths.length; index++) {
		const cellWidth = Math.max(0, cellWidths[index]);
		const separator = row.length ? 1 : 0;
		if (row.length && used + separator + cellWidth > width) {
			rows.push(row);
			row = [];
			used = indent;
		}
		row.push(index);
		used += (row.length > 1 ? 1 : 0) + cellWidth;
	}
	if (row.length || rows.length === 0) rows.push(row);
	return rows;
}
