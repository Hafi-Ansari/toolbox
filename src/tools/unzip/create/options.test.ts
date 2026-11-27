import { expect, it } from "vitest";
import { type CreateOptions, sevenZipSwitches } from "./options.ts";

const common = ["-bsp0", "-bso0", "-sccUTF-8", "-y"];

it.each<[CreateOptions, string[]]>([
	[{ format: "zip", level: "normal", password: "" }, ["-tzip", "-mx5", ...common, "-mcu=on"]],
	[{ format: "zip", level: "store", password: "" }, ["-tzip", "-mx0", ...common, "-mcu=on"]],
	[
		{ format: "zip", level: "fast", password: "s3cret pass" },
		["-tzip", "-mx1", ...common, "-mcu=on", "-ps3cret pass", "-mem=AES256"],
	],
	[{ format: "7z", level: "max", password: "" }, ["-t7z", "-mx9", ...common]],
	[{ format: "7z", level: "normal", password: "pw" }, ["-t7z", "-mx5", ...common, "-ppw", "-mhe=on"]],
	[{ format: "tar.gz", level: "max", password: "ignored" }, ["-ttar", "-so", ...common]],
])("maps %j", (options, expected) => expect(sevenZipSwitches(options)).toEqual(expected));
