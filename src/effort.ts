const EFFORT_ORDER = ["minimal", "low", "medium", "high", "xhigh", "max"];
const EFFORT_SUFFIX = new RegExp(`^(.+)-(${EFFORT_ORDER.join("|")})$`);
const EFFORT_LABEL = new RegExp(`\\s*\\((${EFFORT_ORDER.join("|")})\\)\\s*$`, "i");

export interface CatalogModel {
  id: string;
  displayName?: string;
  maxTokens?: number;
}

export interface AdvertisedModel extends CatalogModel {
  efforts?: string[];
}

const effortGroups = new Map<string, string[]>();
let catalogLoaded: Promise<void> | null = null;

const effortRank = (effort: string): number => EFFORT_ORDER.indexOf(effort);

export function groupEffortVariants(models: CatalogModel[]): AdvertisedModel[] {
  const ids = new Set(models.map((m) => m.id));
  const variantsByBase = new Map<string, CatalogModel[]>();
  for (const model of models) {
    const base = EFFORT_SUFFIX.exec(model.id)?.[1];
    if (!base || ids.has(base)) continue;
    variantsByBase.set(base, [...(variantsByBase.get(base) ?? []), model]);
  }

  effortGroups.clear();
  const advertised: AdvertisedModel[] = [];
  for (const model of models) {
    const base = EFFORT_SUFFIX.exec(model.id)?.[1];
    const variants = base ? variantsByBase.get(base) : undefined;
    if (!base || !variants || variants.length < 2) {
      advertised.push(model);
      continue;
    }
    if (effortGroups.has(base)) continue;
    const efforts = variants
      .map((variant) => EFFORT_SUFFIX.exec(variant.id)![2])
      .sort((a, b) => effortRank(a) - effortRank(b));
    effortGroups.set(base, efforts);
    const maxTokens = Math.max(...variants.map((variant) => variant.maxTokens ?? 0));
    advertised.push({
      id: base,
      displayName: variants[0].displayName?.replace(EFFORT_LABEL, "") || base,
      maxTokens: maxTokens > 0 ? maxTokens : undefined,
      efforts,
    });
  }
  return advertised;
}

export function defaultEffort(efforts: string[]): string {
  return efforts.includes("high") ? "high" : efforts[efforts.length - 1];
}

export function resolveEffortModel(model: string, effort: unknown): string {
  const efforts = effortGroups.get(model);
  if (!efforts) return model;
  const requested = typeof effort === "string" ? effort.toLowerCase() : "";
  if (efforts.includes(requested)) return `${model}-${requested}`;
  if (effortRank(requested) < 0) return `${model}-${defaultEffort(efforts)}`;
  const atOrBelow = efforts.filter((e) => effortRank(e) <= effortRank(requested));
  return `${model}-${atOrBelow.length > 0 ? atOrBelow[atOrBelow.length - 1] : efforts[0]}`;
}

export function ensureCatalogLoaded(load: () => Promise<unknown>): Promise<void> {
  catalogLoaded ??= load().then(
    () => undefined,
    () => {
      catalogLoaded = null;
    },
  );
  return catalogLoaded;
}
