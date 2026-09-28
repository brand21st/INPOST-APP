export type BookableService = "SP_INLAND_PARCEL" | "BUSINESS_PARCEL";

export function articleTypeForService(serviceCode: string): string {
  if (serviceCode === "BUSINESS_PARCEL" || serviceCode === "BP") return "BP";
  if (serviceCode.startsWith("24_") || serviceCode.startsWith("48_")) return serviceCode;
  return "SP";
}

export function articleShape(serviceCode: string, grams: number): "NROL" | "DOC" {
  const type = articleTypeForService(serviceCode);
  if (type === "BP" || serviceCode.includes("PARCEL")) return "NROL";
  if ((type.startsWith("24_") || type.startsWith("48_")) && grams >= 500) return "NROL";
  return "DOC";
}

export function assertBookingRules(input: {
  mobile: string;
  pincode: string;
  officeId: string;
  contractId: string;
}) {
  if (!/^[6-9]\d{9}$/.test(input.mobile)) {
    throw new Error("VALIDATION_ERROR");
  }
  if (!/^\d{6}$/.test(input.pincode)) {
    throw new Error("VALIDATION_ERROR");
  }
  if (!/^\d{8}$/.test(input.officeId)) {
    throw new Error("VALIDATION_ERROR");
  }
  if (!/^\d{4,20}$/.test(input.contractId)) {
    throw new Error("INVALID_CONTRACT");
  }
}

export function buildBookingArticle(input: {
  serviceCode: string;
  barcode: string;
  grams: number;
  contractId: string;
  officeId: string;
  senderName: string;
  senderMobile: string;
  senderPincode: string;
  senderAddress: string;
  receiverName: string;
  receiverMobile: string;
  receiverPincode: string;
  receiverAddress: string;
  codAmount: number;
}) {
  const articleType = articleTypeForService(input.serviceCode);
  const article: Record<string, string | number> = {
    barcode_no: input.barcode,
    article_type: articleType,
    physical_weight: input.grams,
    shape: articleShape(input.serviceCode, input.grams),
    contract_id: input.contractId,
    pickup_or_dropoff: "DROPOFF",
    office_id: input.officeId,
    sender_name: input.senderName,
    sender_mobile: input.senderMobile,
    sender_pincode: input.senderPincode,
    sender_address: input.senderAddress,
    receiver_name: input.receiverName,
    receiver_mobile: input.receiverMobile,
    receiver_pincode: input.receiverPincode,
    receiver_address: input.receiverAddress,
  };
  if (input.codAmount > 0) {
    article.cod_amount = input.codAmount;
    article.payment_mode = "COD";
  }
  return article;
}
