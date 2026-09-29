export function isTrackable(trackingNumber: string | null | undefined, labelStatus: string | null | undefined) {
  return Boolean(trackingNumber?.trim() && labelStatus === "READY");
}

export function trackingUnavailableCopy(trackingNumber: string | null | undefined) {
  return trackingNumber?.trim()
    ? "Label not generated"
    : "Tracking ID pending";
}
