// Where things go: a header row and its rule, the sidebar and the pane, and
// the footer of key hints. The last row stays empty: writing the bottom
// right cell scrolls the classic Windows console. The sidebar grows with
// the window; in a big one it carries Parley's wordmark.
export const minSize = { cols: 60, rows: 16 };
export const headerRows = 2;
export const footerRows = 1;

export const frameCols = (state) => Math.max(1, state.size.cols);
export const frameRows = (state) => Math.max(1, state.size.rows - 1);
export const bodyHeight = (state) =>
  Math.max(1, frameRows(state) - headerRows - footerRows);
export const bodyTop = headerRows;
export const footerY = (state) => frameRows(state) - 1;
export const tooSmall = (state) =>
  state.size.cols < minSize.cols || state.size.rows < minSize.rows;

export function sideWidth(state) {
  const cols = state.size.cols;
  return cols >= 130 ? 46 : cols >= 110 ? 36 : cols >= 96 ? 30 : 26;
}
// A taller window has room for blank rows around the pane's title.
export const roomy = (state) => state.size.rows >= 30;
export const showWordmark = (state) =>
  sideWidth(state) >= 46 && state.size.rows >= 34;
export const padX = (state) => (state.size.cols >= 110 ? 3 : 2);
export const paneHeaderRows = (state) => (roomy(state) ? 4 : 3);
export const composeRows = 3;
export const legendRows = 1;
