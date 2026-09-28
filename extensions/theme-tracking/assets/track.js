document.querySelectorAll(".inpost-track-form").forEach((form) => {
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const root = form.closest(".inpost-track");
    const timeline = root?.querySelector(".inpost-track-timeline");
    const input = form.querySelector("input[name='consignment']");
    const consignment = input instanceof HTMLInputElement ? input.value.trim() : "";
    if (!timeline || !consignment) return;
    timeline.hidden = false;
    timeline.textContent = "Looking up shipment…";
    const response = await fetch(`/apps/inpost/track?consignment=${encodeURIComponent(consignment)}`);
    const body = await response.json();
    if (!response.ok || body.status === "NOT_FOUND") {
      timeline.textContent = "No shipment found for that number.";
      return;
    }
    const events = Array.isArray(body.events) ? body.events : [];
    timeline.textContent = "";
    const status = document.createElement("p");
    status.textContent = `Status: ${body.status}`;
    timeline.append(status);
    events.forEach((item) => {
      const line = document.createElement("p");
      line.textContent = `${item.at ?? ""} ${item.summary ?? ""}`.trim();
      timeline.append(line);
    });
  });
});
