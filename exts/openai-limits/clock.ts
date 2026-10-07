import { execFileSync } from "node:child_process";

export interface Clock {
	time(at: number): string;
	dateTime(at: number): string;
}

type ReadSetting = (command: string, args: string[]) => string | undefined;

function readSetting(command: string, args: string[]): string | undefined {
	try {
		return execFileSync(command, args, { encoding: "utf8", timeout: 1000, maxBuffer: 4096, stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch { return undefined; }
}

export function createClock(locale?: string, hour12?: boolean): Clock {
	const cycle: Intl.DateTimeFormatOptions = hour12 === false ? { hourCycle: "h23" } : hour12 === true ? { hour12: true } : {};
	let time: Intl.DateTimeFormat;
	let dateTime: Intl.DateTimeFormat;
	try {
		time = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", ...cycle });
		dateTime = new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "medium", ...cycle });
	} catch {
		time = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", ...cycle });
		dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "medium", ...cycle });
	}
	return { time: (at) => time.format(at), dateTime: (at) => dateTime.format(at) };
}

export function systemClock(read: ReadSetting = readSetting, platform = process.platform, env = process.env): Clock {
	let hour12: boolean | undefined;
	if (platform === "darwin") {
		const preference = read("defaults", ["read", "-g", "AppleICUForce24HourTime"]);
		if (preference === "1" || preference === "true") hour12 = false;
		else if (preference === "0" || preference === "false") hour12 = true;
	}
	if (hour12 === undefined) {
		const format = read("locale", ["-k", "t_fmt"]);
		if (format && /%[EO]?[Ilr]/.test(format)) hour12 = true;
		else if (format && /%[EO]?[HkRT]/.test(format)) hour12 = false;
	}
	const locale = (env.LC_ALL || env.LC_TIME || env.LANG)?.split(/[.@]/)[0].replaceAll("_", "-");
	return createClock(locale, hour12);
}
