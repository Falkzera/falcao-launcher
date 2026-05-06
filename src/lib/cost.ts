// Forecast de custo mensal baseado em custo acumulado + idade da VM.
// Estratégia: extrapola o custo por hora desta VM no calendário deste mês.
// Se a VM é mais nova que o mês corrente, usa a idade da VM como referência
// (caso típico de VM criada no meio do mês).

export function forecastMonthly(
  costNow: number,
  vmAgeHours: number,
): number | null {
  // Defensive: NaN/Infinity inputs ou custo negativo (impossível com agente
  // atual, mas trivial de blindar) viram null silencioso.
  if (!Number.isFinite(costNow) || !Number.isFinite(vmAgeHours)) return null;
  if (costNow < 0) return null;
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const hoursThisMonth = (now.getTime() - startOfMonth.getTime()) / 3_600_000;
  if (hoursThisMonth <= 0) return null;

  // Total de horas no mês corrente (pega último dia do mês via day=0 do mês seguinte).
  const totalHoursInMonth =
    new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate() * 24;

  const referenceHours = Math.min(vmAgeHours, hoursThisMonth);
  if (referenceHours <= 0) return null;

  return (costNow / referenceHours) * totalHoursInMonth;
}
