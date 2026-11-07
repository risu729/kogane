// Observed response schema; failures never include provider text.
export const MYJCB_POINT_RPC_ID = "200100101";
export interface MyJcbJPointDisplay {
  point: string;
  pointDispFlag: boolean;
  expirePoint: string;
  expirePointDate: string;
  expirePointDispFlag: boolean;
}
export interface MyJcbJPointResponse {
  jsonrpc: "2.0";
  id: string;
  result: {
    errId: "";
    errMessage: "";
    pointJsonInfo: {
      pointHyoujiTanniName: "ポイント";
      normalPointInfo: MyJcbJPointDisplay;
      specialPointInfo: MyJcbJPointDisplay;
      totalPointInfo: MyJcbJPointDisplay;
    };
  };
}
function fail(): never {
  throw new Error("myjcb_jpoint_response_unsupported");
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return fail();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || keys.some((key) => !Object.hasOwn(row, key)))
    return fail();
  return row;
}
function text(value: unknown, max: number): string {
  if (typeof value !== "string" || value.length > max) return fail();
  return value;
}
function display(value: unknown): MyJcbJPointDisplay {
  const row = object(value, [
    "point",
    "pointDispFlag",
    "expirePoint",
    "expirePointDate",
    "expirePointDispFlag",
  ]);
  if (typeof row.pointDispFlag !== "boolean" || typeof row.expirePointDispFlag !== "boolean")
    return fail();
  const point = text(row.point, 64),
    expirePoint = text(row.expirePoint, 64),
    expirePointDate = text(row.expirePointDate, 64);
  if (
    !/^[0-9,-]*$/u.test(point) ||
    !/^[0-9,-]*$/u.test(expirePoint) ||
    !/^[0-9年月日()（）日月火水木金土曜 -]*$/u.test(expirePointDate)
  )
    return fail();
  return {
    point,
    pointDispFlag: row.pointDispFlag,
    expirePoint,
    expirePointDate,
    expirePointDispFlag: row.expirePointDispFlag,
  };
}
export function readMyJcbJPointResponse(value: unknown, expectedId?: string): MyJcbJPointResponse {
  const root = object(value, ["jsonrpc", "id", "result"]),
    id = text(root.id, 9);
  if (
    root.jsonrpc !== "2.0" ||
    !/^2001001[0-9]{2}$/u.test(id) ||
    (expectedId !== undefined && id !== expectedId)
  )
    return fail();
  const result = object(root.result, ["errId", "errMessage", "pointJsonInfo"]);
  if (result.errId !== "" || result.errMessage !== "") return fail();
  const info = object(result.pointJsonInfo, [
    "pointHyoujiTanniName",
    "normalPointInfo",
    "specialPointInfo",
    "totalPointInfo",
  ]);
  if (info.pointHyoujiTanniName !== "ポイント") return fail();
  return {
    jsonrpc: "2.0",
    id,
    result: {
      errId: "",
      errMessage: "",
      pointJsonInfo: {
        pointHyoujiTanniName: "ポイント",
        normalPointInfo: display(info.normalPointInfo),
        specialPointInfo: display(info.specialPointInfo),
        totalPointInfo: display(info.totalPointInfo),
      },
    },
  };
}
