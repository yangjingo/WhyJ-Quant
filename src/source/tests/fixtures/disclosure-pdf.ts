/** A real minimal text PDF with an explicit Unicode map; no mock parser or font downloads. */
export function disclosurePdf(text: string): Uint8Array {
  const hex = (value: string) => [...value].map(char => char.charCodeAt(0).toString(16).padStart(4, "0")).join("");
  const mappings = [...new Set(text)].map(char => `<${hex(char)}> <${hex(char)}>`).join("\n");
  const cmap = `/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /Synthetic-UCS def /CMapType 2 def 1 begincodespacerange <0000> <ffff> endcodespacerange ${new Set(text).size} beginbfchar\n${mappings}\nendbfchar endcmap CMapName currentdict /CMap defineresource pop end end`;
  const pages = text.match(/[\s\S]{1,600}/g) ?? [""];
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${pages.map((_, i) => `${6 + i * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`,
    "<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /Identity-H /DescendantFonts [4 0 R] /ToUnicode 5 0 R >>",
    "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 0 >> /DW 1000 >>",
    `<< /Length ${cmap.length} >>\nstream\n${cmap}\nendstream`];
  for (const [index, page] of pages.entries()) {
    const lines = page.match(/[\s\S]{1,40}/g) ?? [""];
    const stream = `BT /F1 12 Tf 20 850 Td ${lines.map(line => `<${hex(line)}> Tj 0 -18 Td`).join("\n")} ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 900] /Resources << /Font << /F1 3 0 R >> >> /Contents ${7 + index * 2} 0 R >>`,
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  let data = "%PDF-1.4\n"; const offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(data.length); data += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = data.length;
  data += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(value => `${String(value).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(data);
}
