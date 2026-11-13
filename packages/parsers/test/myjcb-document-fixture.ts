import type { MyJcbExportKind } from "../../domain/src/myjcb-statement-export.ts";
/** Entirely synthetic bytes; only public field labels mirror the provider. */
export function creditExportBytes(kind: MyJcbExportKind): Uint8Array {
  if (kind === "csv")
    return new Uint8Array(
      Buffer.from(
        "U3ludGhldGljIHN0YXRlbWVudCBwcmVhbWJsZQ0KgrKXmJdwjtIsg0qDZYNTg4osgrKXmJdwk/osgrKXmJdwkOaCyILHLIKyl5iXcIvginoogY8pLI54laWL5pWqLI2hifGJ8ZCULJL5kLODVINDg5MsgqiOeJWlgqKL4Ip6KIGPKSyNkZPggV6KQ4pPLJNFl3YslPWNbA0Kc2VsZixzeW50aGV0aWMsMjA5OC8wMS8wMyxTeW50aGV0aWMgc2hvcCwxMDAsc2luZ2xlLDEsLDEwMCxkb21lc3RpYywsDQo=",
        "base64",
      ),
    );
  if (kind === "pdf")
    return new TextEncoder().encode("%PDF-1.4\n% synthetic document envelope\n%%EOF\n");
  return new TextEncoder().encode(
    [
      "OFXHEADER:100",
      "DATA:OFXSGML",
      "VERSION:102",
      "SECURITY:NONE",
      "ENCODING:UTF-8",
      "CHARSET:CSUNICODE",
      "COMPRESSION:NONE",
      "",
      "<OFX><CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS><CURDEF>JPY<CCACCTFROM><ACCTID>synthetic</CCACCTFROM><BANKTRANLIST><DTSTART>20980101<DTEND>20980131</BANKTRANLIST></CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>",
    ].join("\n") + "\n",
  );
}
