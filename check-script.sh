#!/bin/bash
# Run before git push to verify script.js is not truncated
FILE="public/script.js"

if [ ! -f "$FILE" ]; then
  echo "❌ ERROR: $FILE not found!"
  exit 1
fi

SIZE=$(wc -c < "$FILE")
LINES=$(wc -l < "$FILE")
NULLS=$(python3 -c "
with open('$FILE','rb') as f: d=f.read()
print(d.count(b'\x00'))
")

echo "📋 script.js check:"
echo "   Size:  $SIZE bytes"
echo "   Lines: $LINES"
echo "   Null bytes: $NULLS"

if [ "$SIZE" -lt 200000 ]; then
  echo "❌ FAIL: File too small — probably truncated! (min 200KB)"
  exit 1
fi
if [ "$LINES" -lt 4000 ]; then
  echo "❌ FAIL: Too few lines — probably truncated! (min 4000)"
  exit 1
fi
if [ "$NULLS" -gt 0 ]; then
  echo "❌ FAIL: Null bytes found — will crash JS!"
  exit 1
fi

# Check key functions exist
for FN in "function showPage" "function openAuthModal" "function sendNewsletter" "function approveCashbackClaim" "function rejectCashbackClaim" "function loadAdminNewsletter"; do
  if ! grep -q "$FN" "$FILE"; then
    echo "❌ FAIL: Missing function: $FN"
    exit 1
  fi
done

echo "✅ script.js looks good — safe to push!"
exit 0
