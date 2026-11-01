#!/bin/bash
# Usage: run.sh <book.djvu> <out.md>
set -u
F="$1"; OUT="$2"
S="$(cd "$(dirname "$0")" && pwd)"
N=$(djvused "$F" -e n)
RAW="$S/raw.txt"; : > "$RAW"
mkdir -p "$S/batch"
for ((start=1; start<=N; start+=10)); do
  end=$(( start+9 < N ? start+9 : N ))
  rm -f "$S"/batch/*.tif
  files=()
  for ((p=start; p<=end; p++)); do
    ddjvu -format=tiff -page=$p -size=2400x3333 "$F" "$S/batch/$p.tif"
    files+=("$S/batch/$p.tif")
  done
  "$S/ocr" "${files[@]}" >> "$RAW"
  echo "pages $start-$end / $N done"
done
rm -rf "$S/batch"
python3 -I - "$RAW" "$OUT" <<'PY'
import re, sys
raw, out = sys.argv[1], sys.argv[2]
pages = open(raw, encoding="utf-8").read().split("\x1e")
pages = [p.strip("\n") for p in pages][: len(pages) - 1]
with open(out, "w", encoding="utf-8") as f:
    for n, text in enumerate(pages, 1):
        # punctuation doubled where a mixed-line re-read overlaps the Korean part
        text = re.sub(r" [-–—]\.? ?[-–—] ?", " — ", text)
        text = re.sub(r"([-–—]) [-–—]", r"\1", text)
        text = re.sub(r"([(\"']+)- ([(\"'])-", r"\2-", text)
        f.write(f"## Page {n}\n\n{text}\n\n")
print(f"wrote {len(pages)} pages to {out}")
PY
