export function createSelectedActivityLoader() {
  let requestNumber = 0;
  return async function load({ leadId, selectedLeadId, fetchActivity, render, onError }) {
    const request = ++requestNumber;
    const isCurrent = () => request === requestNumber && selectedLeadId() === leadId;
    try {
      const activity = await fetchActivity(leadId);
      if (isCurrent()) render(activity);
    } catch (error) {
      if (isCurrent()) onError(error);
    }
  };
}
