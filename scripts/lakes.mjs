// Lacs romands et leurs plages.
// Chaque lac a son modèle Alplakes (model + lake). Les coordonnées de plage
// pointent un point AU LARGE (dans l'eau), pas le rivage, pour que le modèle
// hydrodynamique renvoie une température valide.
// Repris de widget-temperature-lac. Liste des modèles disponibles :
// https://alplakes-api.eawag.ch/simulations/metadata

export const LAKES = [
  {
    name: "Léman",
    model: "delft3d-flow",
    lake: "geneva",
    regions: [
      {
        group: "Genève / La Côte",
        beaches: [
          { name: "Bains des Pâquis", lat: 46.2110, lng: 6.1545 },
          { name: "Genève-Plage", lat: 46.2090, lng: 6.1700 },
          { name: "Versoix", lat: 46.2870, lng: 6.1750 },
          { name: "Nyon", lat: 46.3800, lng: 6.2360 },
          { name: "Rolle", lat: 46.4560, lng: 6.3400 },
          { name: "Morges", lat: 46.5030, lng: 6.4980 },
          { name: "Saint-Sulpice", lat: 46.5110, lng: 6.5560 },
          { name: "Préverenges", lat: 46.5110, lng: 6.5340 },
        ],
      },
      {
        group: "Lausanne / Lavaux",
        beaches: [
          { name: "Vidy", lat: 46.5080, lng: 6.6010 },
          { name: "Ouchy", lat: 46.5040, lng: 6.6270 },
          { name: "Pully", lat: 46.5040, lng: 6.6630 },
          { name: "Lutry", lat: 46.5010, lng: 6.6880 },
          { name: "Cully", lat: 46.4850, lng: 6.7300 },
        ],
      },
      {
        group: "Riviera / Chablais",
        beaches: [
          { name: "Vevey", lat: 46.4560, lng: 6.8460 },
          { name: "La Tour-de-Peilz", lat: 46.4520, lng: 6.8600 },
          { name: "Montreux", lat: 46.4320, lng: 6.9130 },
          { name: "Villeneuve", lat: 46.3960, lng: 6.9230 },
          { name: "Le Bouveret", lat: 46.3850, lng: 6.8550 },
        ],
      },
      {
        group: "France",
        beaches: [
          { name: "Yvoire", lat: 46.3680, lng: 6.3290 },
          { name: "Excenevex", lat: 46.3470, lng: 6.3560 },
          { name: "Thonon-les-Bains", lat: 46.3760, lng: 6.4810 },
          { name: "Évian-les-Bains", lat: 46.4020, lng: 6.5880 },
        ],
      },
    ],
  },
  {
    name: "Lac de Neuchâtel",
    model: "mitgcm",
    lake: "neuchatel",
    beaches: [
      { name: "Neuchâtel", lat: 46.9980, lng: 6.9450 },
      { name: "Pointe du Grain", lat: 46.9300, lng: 6.8300 },
      { name: "Grandson", lat: 46.8120, lng: 6.6500 },
      { name: "Yverdon-les-Bains", lat: 46.7850, lng: 6.6550 },
      { name: "Yvonand", lat: 46.8080, lng: 6.7380 },
      { name: "Cheyres", lat: 46.8000, lng: 6.7820 },
      { name: "Estavayer-le-Lac", lat: 46.8470, lng: 6.8500 },
      { name: "Portalban", lat: 46.9280, lng: 6.9450 },
      { name: "Cudrefin", lat: 46.9550, lng: 7.0150 },
    ],
  },
  {
    name: "Lac de Bienne",
    model: "delft3d-flow",
    lake: "biel",
    beaches: [
      { name: "Bienne", lat: 47.1320, lng: 7.2200 },
      { name: "Douanne", lat: 47.0950, lng: 7.1550 },
      { name: "La Neuveville", lat: 47.0680, lng: 7.1050 },
    ],
  },
  {
    name: "Lac de Morat",
    model: "delft3d-flow",
    lake: "murten",
    beaches: [
      { name: "Morat", lat: 46.9290, lng: 7.1080 },
      { name: "Avenches", lat: 46.9180, lng: 7.0500 },
      { name: "Praz (Vully)", lat: 46.9450, lng: 7.0850 },
    ],
  },
  {
    name: "Lac de Joux",
    model: "delft3d-flow",
    lake: "joux",
    beaches: [
      { name: "Le Pont", lat: 46.6660, lng: 6.3210 },
      { name: "L'Abbaye", lat: 46.6480, lng: 6.2950 },
      { name: "Le Rocheray", lat: 46.6280, lng: 6.2400 },
    ],
  },
];

// Aplatit la structure en une liste de plages, chacune portant les infos de
// son lac (et son groupe régional pour le Léman). id stable = lake+slug.
export function flattenBeaches() {
  const out = [];
  for (const lk of LAKES) {
    const groups = lk.regions
      ? lk.regions.map((r) => ({ group: r.group, beaches: r.beaches }))
      : [{ group: null, beaches: lk.beaches }];
    for (const g of groups) {
      for (const b of g.beaches) {
        const slug = b.name
          .toLowerCase()
          .normalize("NFD")
          .replace(/[̀-ͯ]/g, "")
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/(^-|-$)/g, "");
        out.push({
          id: `${lk.lake}-${slug}`,
          name: b.name,
          lat: b.lat,
          lng: b.lng,
          lakeName: lk.name,
          model: lk.model,
          lake: lk.lake,
          group: g.group,
        });
      }
    }
  }
  return out;
}
