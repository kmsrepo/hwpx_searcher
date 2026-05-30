async function importTanStackVirtualCore(source) {
  if (!source?.indexJs || !source?.utilsJs || !source?.lazyMeasurementsJs) {
    return null;
  }

  const urls = [];
  const createModuleUrl = (moduleSource) => {
    const url = URL.createObjectURL(new Blob([moduleSource], { type: "text/javascript" }));
    urls.push(url);
    return url;
  };

  const utilsUrl = createModuleUrl(source.utilsJs);
  const lazyMeasurementsUrl = createModuleUrl(source.lazyMeasurementsJs);
  const indexUrl = createModuleUrl(
    source.indexJs
      .replaceAll('"./utils.js"', JSON.stringify(utilsUrl))
      .replaceAll('"./lazy-measurements.js"', JSON.stringify(lazyMeasurementsUrl)),
  );

  try {
    return await import(indexUrl);
  } finally {
    for (const url of urls) {
      URL.revokeObjectURL(url);
    }
  }
}
