import { WindowsChromeCdpJscProvider } from "./windows-chrome-jsc";

const value = await new WindowsChromeCdpJscProvider().acquire();
console.log(
  JSON.stringify({
    event: "sbi-shinsei-jsc-handoff-ready",
    sourceOrigin: value.sourceOrigin,
    jscLength: value.jsc.length,
    userAgentLength: value.userAgent.length,
  }),
);
