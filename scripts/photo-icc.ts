// Writes the converter's compact Display P3 ICC profile to stdout (used by scripts/photo-fixtures.py).
import { iccProfile } from "../src/tools/photo/color.ts";

process.stdout.write(iccProfile("p3"));
