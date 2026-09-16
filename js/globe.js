    // ==========================================
    // X1 Network Functions — Validator Globe
    // ==========================================
    //
    // The validator map is a WebGL globe (globe.gl / three.js). It replaced the
    // Leaflet + CARTO raster-tile map after CARTO began watermarking keyless
    // tile requests ("API KEY REQUIRED"). The globe needs no tile provider at
    // all: country outlines come from a small TopoJSON file and everything
    // else is generated on the GPU, so there is no third-party map service
    // that can break, rate-limit or re-license this page again.
    //
    // Layers (all globe.gl built-ins):
    //   hexPolygons — countries drawn as a hex-dot mesh; countries hosting
    //                 validators are lit brighter than the rest
    //   points      — one glowing dot per city, radius scaled by validator count
    //   rings       — pulsing rings on the biggest hubs
    //   arcs        — slow animated arcs between the top hubs (decorative)
    //
    // Both data paths in loadValidatorLocations() (static JSON, live RPC)
    // end in renderGlobeData(points, countries).

    let validatorMap = null;          // globe.gl instance (name kept for legacy call sites)
    window.mapInitialized = false;

    const GLOBE_LIB_URL      = 'https://unpkg.com/globe.gl@2.46.2/dist/globe.gl.min.js';
    const TOPOJSON_LIB_URL   = 'https://unpkg.com/topojson-client@3.1.0/dist/topojson-client.min.js';
    const WORLD_ATLAS_URL    = 'https://unpkg.com/world-atlas@2.0.2/countries-110m.json';
    const GLOBE_HOME_VIEW    = { lat: 30, lng: -35, altitude: 2.0 };  // Atlantic view: US + Europe in frame
    const GLOBE_ROTATE_SPEED = 0.9;
    const GLOBE_AUTOROTATE_MS = 60 * 1000;   // spin for a minute after load, then rest                                  // OrbitControls.autoRotateSpeed (~65 s per revolution)
    const GLOBE_HUB_COUNT    = 12;                                   // cities that get pulsing rings
    const GLOBE_ARC_HUBS     = 6;                                    // top cities joined by arcs

    const GLOBE_COLORS = {
      dot:        '#00d4ff',
      dotDim:     'rgba(0, 212, 255, 0.28)',
      dotHot:     '#ffffff',
      landLit:    'rgba(90, 178, 255, 0.85)',
      landHot:    'rgba(0, 212, 255, 1)',
      landDark:   'rgba(77, 166, 255, 0.24)',
      atmosphere: '#4da6ff'
    };

    // world-atlas features carry numeric ISO-3166 ids; geo data uses alpha-2.
    const ISO_NUMERIC_TO_ALPHA2 = {4:'AF',8:'AL',10:'AQ',12:'DZ',24:'AO',31:'AZ',32:'AR',36:'AU',40:'AT',44:'BS',50:'BD',51:'AM',56:'BE',64:'BT',68:'BO',70:'BA',72:'BW',76:'BR',84:'BZ',90:'SB',96:'BN',100:'BG',104:'MM',108:'BI',112:'BY',116:'KH',120:'CM',124:'CA',140:'CF',144:'LK',148:'TD',152:'CL',156:'CN',158:'TW',170:'CO',178:'CG',180:'CD',188:'CR',191:'HR',192:'CU',196:'CY',203:'CZ',204:'BJ',208:'DK',214:'DO',218:'EC',222:'SV',226:'GQ',231:'ET',232:'ER',233:'EE',238:'FK',242:'FJ',246:'FI',250:'FR',260:'TF',262:'DJ',266:'GA',268:'GE',270:'GM',275:'PS',276:'DE',288:'GH',300:'GR',304:'GL',320:'GT',324:'GN',328:'GY',332:'HT',340:'HN',348:'HU',352:'IS',356:'IN',360:'ID',364:'IR',368:'IQ',372:'IE',376:'IL',380:'IT',384:'CI',388:'JM',392:'JP',398:'KZ',400:'JO',404:'KE',408:'KP',410:'KR',414:'KW',417:'KG',418:'LA',422:'LB',426:'LS',428:'LV',430:'LR',434:'LY',440:'LT',442:'LU',450:'MG',454:'MW',458:'MY',466:'ML',478:'MR',484:'MX',496:'MN',498:'MD',499:'ME',504:'MA',508:'MZ',512:'OM',516:'NA',524:'NP',528:'NL',540:'NC',548:'VU',554:'NZ',558:'NI',562:'NE',566:'NG',578:'NO',586:'PK',591:'PA',598:'PG',600:'PY',604:'PE',608:'PH',616:'PL',620:'PT',624:'GW',626:'TL',630:'PR',634:'QA',642:'RO',643:'RU',646:'RW',682:'SA',686:'SN',688:'RS',694:'SL',703:'SK',704:'VN',705:'SI',706:'SO',710:'ZA',716:'ZW',724:'ES',728:'SS',729:'SD',732:'EH',740:'SR',748:'SZ',752:'SE',756:'CH',760:'SY',762:'TJ',764:'TH',768:'TG',780:'TT',784:'AE',788:'TN',792:'TR',795:'TM',800:'UG',804:'UA',807:'MK',818:'EG',826:'GB',834:'TZ',840:'US',854:'BF',858:'UY',860:'UZ',862:'VE',887:'YE',894:'ZM'};

    const globeState = {
      points: [],           // [{ lat, lng, city, country, countryCode, count, names[] }]
      countries: {},        // code -> { name, count, lat, lng }
      hubs: [],             // top points by count
      selectedCountry: null,
      userPaused: false,    // pause button pressed
      hoverPaused: false,   // pointer is over the globe
      resumeTimer: null,
      rotateUntil: 0,       // auto-rotation stops after this timestamp (power)
      loopTimer: null,      // pauses the WebGL render loop once nothing moves
      landFeatures: null,   // GeoJSON features for hexPolygons
      landCountries: new Set()
    };

    // ---- Library loading -------------------------------------------------

    function loadScriptOnce(url) {
      return new Promise((resolve, reject) => {
        const existing = document.querySelector(`script[src="${url}"]`);
        if (existing) {
          if (existing.dataset.loaded === '1') return resolve();
          existing.addEventListener('load', () => resolve());
          existing.addEventListener('error', () => reject(new Error('Failed to load ' + url)));
          return;
        }
        const s = document.createElement('script');
        s.src = url;
        s.async = true;
        s.onload = () => { s.dataset.loaded = '1'; resolve(); };
        s.onerror = () => reject(new Error('Failed to load ' + url));
        document.head.appendChild(s);
      });
    }

    async function loadGlobeLibrary() {
      if (typeof Globe === 'function') return;
      await loadScriptOnce(GLOBE_LIB_URL);
      if (typeof Globe !== 'function') throw new Error('globe.gl did not initialise');
    }

    function webglAvailable() {
      try {
        const c = document.createElement('canvas');
        return !!(window.WebGLRenderingContext &&
          (c.getContext('webgl2') || c.getContext('webgl') || c.getContext('experimental-webgl')));
      } catch (e) {
        return false;
      }
    }

    // Country outlines. Failure here is non-fatal: the globe still renders
    // as a plain sphere with the validator dots on it.
    async function loadLandFeatures() {
      if (globeState.landFeatures) return globeState.landFeatures;
      try {
        await loadScriptOnce(TOPOJSON_LIB_URL);
        const res = await fetch(WORLD_ATLAS_URL);
        if (!res.ok) throw new Error('world-atlas HTTP ' + res.status);
        const topo = await res.json();
        const geo = topojson.feature(topo, topo.objects.countries);

        // world-atlas contains the odd degenerate ring (e.g. a 4-point polygon
        // where every vertex is identical) which makes H3 throw and abort the
        // whole hex layer. Keep only rings with >= 4 distinct vertices.
        const ringOk = ring => new Set(ring.map(p => p[0] + ',' + p[1])).size >= 4;
        const sanitize = geom => {
          if (!geom) return null;
          if (geom.type === 'Polygon') return ringOk(geom.coordinates[0]) ? geom : null;
          if (geom.type === 'MultiPolygon') {
            const polys = geom.coordinates.filter(poly => ringOk(poly[0]));
            return polys.length ? { type: 'MultiPolygon', coordinates: polys } : null;
          }
          return null;
        };

        globeState.landFeatures = geo.features
          .filter(f => f.id !== '010')                       // drop Antarctica
          .map(f => {
            const geometry = sanitize(f.geometry);
            if (!geometry) return null;
            const alpha2 = ISO_NUMERIC_TO_ALPHA2[parseInt(f.id, 10)] ||
              (f.properties && f.properties.name === 'Kosovo' ? 'XK' : null);
            return { type: 'Feature', id: f.id, geometry, properties: Object.assign({}, f.properties, { alpha2 }) };
          })
          .filter(Boolean);
        return globeState.landFeatures;
      } catch (err) {
        console.warn('[globe] country outlines unavailable:', err.message || err);
        globeState.landFeatures = [];
        return globeState.landFeatures;
      }
    }

    // ---- Globe construction -----------------------------------------------

    function globeContainerSize() {
      const wrapper = document.querySelector('.map-wrapper');
      const rect = wrapper ? wrapper.getBoundingClientRect() : { width: 0, height: 0 };
      return {
        width: Math.max(1, Math.round(rect.width || wrapper?.clientWidth || 800)),
        height: Math.max(1, Math.round(rect.height || wrapper?.clientHeight || 450))
      };
    }

    function resizeGlobe() {
      if (!validatorMap) return;
      const { width, height } = globeContainerSize();
      validatorMap.width(width).height(height);
    }

    function showGlobeFallback(message) {
      const el = document.getElementById('globeFallback');
      if (!el) return;
      el.textContent = message;
      el.classList.add('show');
      const btn = document.getElementById('globeRotateBtn');
      if (btn) btn.style.display = 'none';
    }

    // Auto-rotation is on unless the user paused it, is hovering/dragging,
    // or a country has just been selected.
    function applyRotationState() {
      if (!validatorMap) return;
      const controls = validatorMap.controls();
      const idle = (typeof PowerSaver !== 'undefined') && !PowerSaver.isActive();
      const expired = Date.now() > globeState.rotateUntil;
      controls.autoRotate = !globeState.userPaused && !globeState.hoverPaused && !globeState.selectedCountry && !idle && !expired;
      globeScheduleLoop();
    }

    // Render-on-demand: three.js redraws 60× a second for as long as the
    // animation loop runs. With rotation off and nobody touching the globe
    // there is nothing to draw, so pause the loop ~1.5 s after the last
    // movement (long enough for OrbitControls damping to settle) and resume
    // it on the next pointer/wheel event or when rotation restarts.
    function globeScheduleLoop() {
      if (!validatorMap) return;
      clearTimeout(globeState.loopTimer);
      const controls = validatorMap.controls();
      const idle = (typeof PowerSaver !== 'undefined') && !PowerSaver.isActive();
      if (controls.autoRotate && !idle) { validatorMap.resumeAnimation(); return; }
      validatorMap.resumeAnimation();   // draw the settle frames…
      globeState.loopTimer = setTimeout(() => {
        if (!validatorMap) return;
        if (validatorMap.controls().autoRotate && PowerSaver.isActive()) return;
        validatorMap.pauseAnimation();  // …then stop until something moves
      }, 1500);
    }

    // NOTE: only toggle attributes here — never rebuild the button's inner
    // DOM from a pointer handler, or the element under the cursor gets
    // detached mid-gesture and the click is lost.
    function renderRotateButton() {
      const btn = document.getElementById('globeRotateBtn');
      if (!btn) return;
      const paused = globeState.userPaused;
      btn.title = paused ? 'Resume rotation' : 'Pause rotation';
      btn.setAttribute('aria-label', btn.title);
      btn.setAttribute('aria-pressed', paused ? 'true' : 'false');
      const pauseIcon = btn.querySelector('.globe-btn-pause');
      const playIcon = btn.querySelector('.globe-btn-play');
      if (pauseIcon) pauseIcon.hidden = paused;
      if (playIcon) playIcon.hidden = !paused;
    }

    function toggleGlobeRotation() {
      globeState.userPaused = !globeState.userPaused;
      if (!globeState.userPaused) { clearGlobeSelection(); globeState.rotateUntil = Date.now() + GLOBE_AUTOROTATE_MS; }
      renderRotateButton();
      applyRotationState();
    }

    function pointColorFor(d) {
      if (!globeState.selectedCountry) return GLOBE_COLORS.dot;
      return d.countryCode === globeState.selectedCountry ? GLOBE_COLORS.dotHot : GLOBE_COLORS.dotDim;
    }

    function landColorFor(f) {
      const code = f.properties && f.properties.alpha2;
      if (globeState.selectedCountry && code === globeState.selectedCountry) return GLOBE_COLORS.landHot;
      return code && globeState.landCountries.has(code) ? GLOBE_COLORS.landLit : GLOBE_COLORS.landDark;
    }

    // Point radius in degrees: ~3px dot for a single validator, growing
    // logarithmically so a 40-validator hub is clearly bigger but not huge.
    function pointRadiusFor(d) {
      return 0.34 + Math.min(0.95, Math.log2(1 + (d.count || 1)) * 0.18);
    }

    function pointTooltip(d) {
      const n = d.count || 1;
      const names = (d.names || []).filter(Boolean).slice(0, 3);
      const extra = n - names.length;
      const nameLine = names.length
        ? `<div class="popup-validator-location">${escHtml(names.join(', '))}${extra > 0 ? ` +${extra} more` : ''}</div>`
        : '';
      return `
        <div class="popup-validator-name">${escHtml(d.city || 'Unknown city')}</div>
        <div class="popup-validator-location">${countryFlags[d.countryCode] || '🌍'} ${escHtml(d.country || '')}</div>
        ${nameLine}
        <div class="popup-validator-count">${n} <span>${n === 1 ? 'validator' : 'validators'}</span></div>
      `;
    }

    async function buildGlobe() {
      const container = document.getElementById('validatorMap');
      const { width, height } = globeContainerSize();

      const globe = Globe({ animateIn: true, rendererConfig: { antialias: true, alpha: true } })(container)
        .width(width)
        .height(height)
        .backgroundColor('rgba(0,0,0,0)')
        .showAtmosphere(true)
        .atmosphereColor(GLOBE_COLORS.atmosphere)
        .atmosphereAltitude(0.22)
        // hex-dot land mesh
        .hexPolygonsData([])
        .hexPolygonResolution(3)
        .hexPolygonMargin(0.45)
        .hexPolygonUseDots(true)
        .hexPolygonAltitude(0.004)
        .hexPolygonColor(landColorFor)
        .hexPolygonsTransitionDuration(0)
        // validator dots
        .pointsData([])
        .pointLat('lat')
        .pointLng('lng')
        .pointColor(pointColorFor)
        .pointAltitude(0.012)
        .pointRadius(pointRadiusFor)
        .pointResolution(14)
        .pointsTransitionDuration(600)
        .pointLabel(pointTooltip)
        .onPointClick(d => selectGlobeCountry(d.countryCode, true))
        // pulsing hub rings
        .ringsData([])
        .ringLat('lat')
        .ringLng('lng')
        .ringAltitude(0.013)
        .ringColor(() => t => `rgba(0, 212, 255, ${(1 - t) * 0.55})`)
        .ringMaxRadius(d => 1.6 + Math.min(4.5, Math.log2(1 + d.count) * 0.9))
        .ringPropagationSpeed(d => 0.9 + Math.min(1.6, Math.log2(1 + d.count) * 0.25))
        .ringRepeatPeriod(d => 1500 + (d.ringOffset || 0))
        // hub-to-hub arcs
        .arcsData([])
        .arcStartLat(a => a.from.lat).arcStartLng(a => a.from.lng)
        .arcEndLat(a => a.to.lat).arcEndLng(a => a.to.lng)
        .arcColor(() => ['rgba(0, 212, 255, 0)', 'rgba(0, 212, 255, 0.75)', 'rgba(77, 166, 255, 0)'])
        .arcAltitudeAutoScale(0.32)
        .arcStroke(0.32)
        .arcDashLength(0.35)
        .arcDashGap(1.4)
        .arcDashInitialGap(a => a.dashOffset)
        .arcDashAnimateTime(5200)
        .arcsTransitionDuration(0);

      // Sphere styling: deep navy body with a faint self-glow so the night
      // side never goes fully black against the card.
      const mat = globe.globeMaterial();
      if (mat) {
        if (mat.color)    mat.color.set('#0b1730');
        if (mat.emissive) { mat.emissive.set('#0a1a36'); mat.emissiveIntensity = 0.55; }
        if ('shininess' in mat) mat.shininess = 6;
        if ('specular' in mat && mat.specular) mat.specular.set('#0e2a4a');
      }

      // Camera + controls
      globe.pointOfView(GLOBE_HOME_VIEW, 0);
      const controls = globe.controls();
      controls.autoRotate = true;
      controls.autoRotateSpeed = GLOBE_ROTATE_SPEED;
      globeState.rotateUntil = Date.now() + GLOBE_AUTOROTATE_MS;
      setTimeout(() => applyRotationState(), GLOBE_AUTOROTATE_MS + 50);
      // Retina screens: 2× pixel ratio is 4× the fragments for a decorative
      // globe. 1.5 is visually indistinguishable here and much cheaper.
      try { globe.renderer().setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5)); } catch (e) {}
      if (typeof PowerSaver !== 'undefined') PowerSaver.onChange(() => applyRotationState());
      controls.enablePan = false;
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;
      controls.minDistance = 130;   // globe radius is 100 => never clip inside
      controls.maxDistance = 420;
      controls.zoomSpeed = 0.6;

      // Pause while hovering / dragging, resume shortly after the pointer leaves.
      const wrapper = document.querySelector('.map-wrapper');
      if (wrapper) {
        const pause = () => { clearTimeout(globeState.resumeTimer); globeState.hoverPaused = true; applyRotationState(); };
        const resume = () => {
          clearTimeout(globeState.resumeTimer);
          globeState.resumeTimer = setTimeout(() => { globeState.hoverPaused = false; applyRotationState(); }, 900);
        };
        wrapper.addEventListener('pointerenter', pause);
        wrapper.addEventListener('pointerdown', pause);
        wrapper.addEventListener('pointerleave', resume);
        wrapper.addEventListener('touchend', resume, { passive: true });
        // Any movement over the globe keeps the render loop alive; it pauses
        // itself 1.5 s after the last event (globeScheduleLoop).
        ['pointermove', 'wheel', 'touchmove'].forEach(ev => wrapper.addEventListener(ev, globeScheduleLoop, { passive: true }));
        controls.addEventListener('change', globeScheduleLoop);
      }

      // Save GPU/CPU when the globe is scrolled away, on another tab, or the
      // browser tab is hidden.
      if ('IntersectionObserver' in window && wrapper) {
        const io = new IntersectionObserver(entries => {
          entries.forEach(e => e.isIntersecting ? applyRotationState() : globe.pauseAnimation());
        }, { threshold: 0.05 });
        io.observe(wrapper);
      }
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) globe.pauseAnimation(); else applyRotationState();
      });

      // Keep the canvas sized to its container.
      if ('ResizeObserver' in window && wrapper) {
        let raf = null;
        new ResizeObserver(() => {
          cancelAnimationFrame(raf);
          raf = requestAnimationFrame(resizeGlobe);
        }).observe(wrapper);
      } else {
        window.addEventListener('resize', resizeGlobe);
      }

      validatorMap = globe;
      applyRotationState();

      // Land mesh loads in the background; dots can already be on screen.
      loadLandFeatures().then(features => {
        if (validatorMap && features && features.length) validatorMap.hexPolygonsData(features);
      });

      return globe;
    }

    // Initialize the map (called from init() and from switchTab('map'))
    async function initializeMap() {
      if (window.mapInitialized) return;
      window.mapInitialized = true;

      const loadingEl = document.getElementById('mapLoading');

      if (!webglAvailable()) {
        if (loadingEl) loadingEl.style.display = 'none';
        showGlobeFallback('Your browser does not support WebGL, so the 3D validator globe cannot be shown. The country breakdown is on the right.');
        await loadValidatorLocations();
        return;
      }

      try {
        await loadGlobeLibrary();
        await buildGlobe();
      } catch (err) {
        console.error('[globe] failed to start:', err);
        if (loadingEl) loadingEl.style.display = 'none';
        showGlobeFallback('The 3D globe could not be loaded right now. The country breakdown on the right is still live.');
        await loadValidatorLocations();
        return;
      }

      await loadValidatorLocations();
      if (loadingEl) loadingEl.style.display = 'none';
    }

    // ---- Data -> globe ----------------------------------------------------

    // Collapse per-IP / per-node records into one point per city so the
    // globe shows ~150 clean dots instead of 600 overlapping ones.
    function aggregateGlobePoints(records) {
      const byCity = new Map();
      records.forEach(r => {
        if (!r || !isFinite(r.lat) || !isFinite(r.lon)) return;
        const code = (r.countryCode || '').toUpperCase();
        const city = (r.city || '').trim();
        // Group by country + city name; IP geolocation scatters coordinates a
        // little within one city, so only fall back to a coarse lat/lon grid
        // when the city is unknown.
        const key = city && city.toLowerCase() !== 'unknown'
          ? `${code}|${city.toLowerCase()}`
          : `${code}|?|${Math.round(r.lat * 2) / 2}|${Math.round(r.lon * 2) / 2}`;
        let p = byCity.get(key);
        if (!p) {
          p = { lat: 0, lng: 0, city: r.city || 'Unknown', country: r.country || '', countryCode: code, count: 0, names: [] };
          byCity.set(key, p);
        }
        const n = r.count || 1;
        // running weighted centroid so clustered IPs settle on the city centre
        p.lat = (p.lat * p.count + r.lat * n) / (p.count + n);
        p.lng = (p.lng * p.count + r.lon * n) / (p.count + n);
        p.count += n;
        if (r.name) p.names.push(r.name);
      });
      return Array.from(byCity.values()).sort((a, b) => b.count - a.count);
    }

    function buildCountryIndex(points, countryCounts) {
      const countries = {};
      points.forEach(p => {
        if (!p.countryCode) return;
        const c = countries[p.countryCode] || (countries[p.countryCode] = { name: p.country, count: 0, lat: 0, lng: 0 });
        c.lat = (c.lat * c.count + p.lat * p.count) / (c.count + p.count);
        c.lng = (c.lng * c.count + p.lng * p.count) / (c.count + p.count);
        c.count += p.count;
      });
      // Prefer the authoritative counts/names from the static file when present.
      if (countryCounts) {
        Object.entries(countryCounts).forEach(([code, data]) => {
          const c = countries[code] || (countries[code] = { name: data.name, count: 0, lat: 0, lng: 0 });
          c.name = data.name || c.name;
          c.count = data.count || c.count;
        });
      }
      return countries;
    }

    function renderCountryList(countries) {
      const sorted = Object.entries(countries).sort((a, b) => b[1].count - a[1].count);
      const listEl = document.getElementById('countryList');
      if (!listEl) return;
      if (!sorted.length) {
        listEl.innerHTML = '<div class="map-loading-text" style="padding: 1rem;">Could not load location data.</div>';
        return;
      }
      listEl.innerHTML = sorted.map(([code, data]) => `
        <div class="country-item${globeState.selectedCountry === code ? ' active' : ''}" data-country="${escHtml(code)}" role="button" tabindex="0" title="Fly to ${escHtml(data.name)}">
          <div class="country-info">
            <span class="country-flag">${countryFlags[code] || '🌍'}</span>
            <span class="country-name">${escHtml(data.name)}</span>
          </div>
          <span class="country-count">${data.count}</span>
        </div>
      `).join('');

      if (!listEl.dataset.bound) {
        listEl.dataset.bound = '1';
        const activate = (target) => {
          const item = target.closest('.country-item');
          if (item && item.dataset.country) selectGlobeCountry(item.dataset.country, true);
        };
        listEl.addEventListener('click', e => activate(e.target));
        listEl.addEventListener('keydown', e => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(e.target); }
        });
      }
    }

    // The globe can only place validators that are visible in gossip with a
    // public IP, so "located" is always <= the header's vote-account total
    // (which includes offline/delinquent validators). Show both so the gap is
    // explicit rather than looking like a bug.
    function renderGlobeStats(points, countries) {
      const el = document.getElementById('globeStats');
      if (!el) return;
      const located = Object.values(countries).reduce((s, c) => s + (c.count || 0), 0) ||
        points.reduce((s, p) => s + p.count, 0);
      const total = (typeof allValidators !== 'undefined' && allValidators && allValidators.length > located)
        ? allValidators.length : null;
      const note = 'Validators seen in gossip with a public IP. Offline / delinquent validators have no address to place on the map.';
      const locatedChip = total
        ? `<div class="globe-stat" title="${note}"><b>${located}</b> of <b>${total}</b> validators located</div>`
        : `<div class="globe-stat" title="${note}"><b>${located}</b> validators located</div>`;
      el.innerHTML =
        locatedChip +
        `<div class="globe-stat"><b>${Object.keys(countries).length}</b> countries</div>` +
        `<div class="globe-stat"><b>${points.length}</b> cities</div>`;
    }

    function renderGlobeData(points, countries) {
      globeState.points = points;
      globeState.countries = countries;
      globeState.landCountries = new Set(Object.keys(countries));
      globeState.hubs = points.slice(0, GLOBE_HUB_COUNT).map((p, i) => Object.assign({ ringOffset: (i * 137) % 900 }, p));

      renderCountryList(countries);
      renderGlobeStats(points, countries);

      if (!validatorMap) return;

      // Arcs: the #1 hub links to the next few, and neighbours link in a chain,
      // which reads as a mesh without drawing n² lines.
      const arcHubs = points.slice(0, GLOBE_ARC_HUBS);
      const arcs = [];
      for (let i = 1; i < arcHubs.length; i++) {
        arcs.push({ from: arcHubs[0], to: arcHubs[i], dashOffset: Math.random() * 2 });
        if (i + 1 < arcHubs.length) arcs.push({ from: arcHubs[i], to: arcHubs[i + 1], dashOffset: Math.random() * 2 });
      }

      validatorMap
        .pointsData(points)
        .ringsData(globeState.hubs)
        .arcsData(arcs)
        .hexPolygonColor(landColorFor);   // re-evaluate now that landCountries is known
    }

    // ---- Interaction --------------------------------------------------------

    function clearGlobeSelection() {
      if (!globeState.selectedCountry) return;
      globeState.selectedCountry = null;
      document.querySelectorAll('#countryList .country-item.active').forEach(el => el.classList.remove('active'));
      if (validatorMap) {
        validatorMap.pointColor(pointColorFor).hexPolygonColor(landColorFor);
      }
      applyRotationState();
    }

    // Fly the globe to a country and light up its validators. Clicking the
    // active country again (or pressing play) clears the selection.
    function selectGlobeCountry(code, fly) {
      if (!code) return;
      if (globeState.selectedCountry === code) { clearGlobeSelection(); return; }

      globeState.selectedCountry = code;
      document.querySelectorAll('#countryList .country-item').forEach(el => {
        el.classList.toggle('active', el.dataset.country === code);
      });
      const activeRow = document.querySelector('#countryList .country-item.active');
      if (activeRow && activeRow.scrollIntoView) activeRow.scrollIntoView({ block: 'nearest', behavior: 'smooth' });

      if (!validatorMap) return;
      validatorMap.pointColor(pointColorFor).hexPolygonColor(landColorFor);
      applyRotationState();

      const c = globeState.countries[code];
      if (fly && c && isFinite(c.lat) && isFinite(c.lng)) {
        // Flush any leftover auto-rotation momentum (OrbitControls damping)
        // so the camera does not keep creeping after the fly-to lands.
        const controls = validatorMap.controls();
        const hadDamping = controls.enableDamping;
        controls.enableDamping = false;
        controls.update();
        controls.enableDamping = hadDamping;

        // Wide countries (US, Canada, Russia) need a bit more altitude.
        const spread = globeState.points
          .filter(p => p.countryCode === code)
          .reduce((m, p) => Math.max(m, Math.abs(p.lng - c.lng), Math.abs(p.lat - c.lat)), 0);
        const altitude = Math.min(1.9, Math.max(0.9, 0.85 + spread / 22));
        validatorMap.pointOfView({ lat: c.lat, lng: c.lng, altitude }, 1400);
      }
    }

    // Country code to flag emoji mapping
    const countryFlags = {
      'US': '🇺🇸', 'DE': '🇩🇪', 'FR': '🇫🇷', 'GB': '🇬🇧', 'NL': '🇳🇱', 
      'CA': '🇨🇦', 'AU': '🇦🇺', 'JP': '🇯🇵', 'SG': '🇸🇬', 'KR': '🇰🇷',
      'SE': '🇸🇪', 'FI': '🇫🇮', 'CH': '🇨🇭', 'IE': '🇮🇪', 'PL': '🇵🇱',
      'ES': '🇪🇸', 'IT': '🇮🇹', 'BR': '🇧🇷', 'IN': '🇮🇳', 'RU': '🇷🇺',
      'CN': '🇨🇳', 'HK': '🇭🇰', 'TW': '🇹🇼', 'UA': '🇺🇦', 'CZ': '🇨🇿',
      'AT': '🇦🇹', 'BE': '🇧🇪', 'DK': '🇩🇰', 'NO': '🇳🇴', 'PT': '🇵🇹',
      'RO': '🇷🇴', 'BG': '🇧🇬', 'HU': '🇭🇺', 'GR': '🇬🇷', 'LT': '🇱🇹',
      'LV': '🇱🇻', 'EE': '🇪🇪', 'SK': '🇸🇰', 'SI': '🇸🇮', 'HR': '🇭🇷',
      'RS': '🇷🇸', 'ZA': '🇿🇦', 'MX': '🇲🇽', 'AR': '🇦🇷', 'CL': '🇨🇱',
      'NZ': '🇳🇿', 'TH': '🇹🇭', 'VN': '🇻🇳', 'MY': '🇲🇾', 'ID': '🇮🇩',
      'PH': '🇵🇭', 'AE': '🇦🇪', 'IL': '🇮🇱', 'TR': '🇹🇷', 'SA': '🇸🇦'
    };

    // Get cluster nodes with IPs
    async function getClusterNodesWithIPs() {
      try {
        const nodes = await rpcCall('getClusterNodes');
        return nodes;
      } catch (err) {
        console.error('Error fetching cluster nodes:', err);
        return [];
      }
    }

    // Geolocation - loads from local JSON file (auto-updated hourly by GitHub Actions)
    const GEO_DATA_URLS = [
      'validator-locations.json',
      './validator-locations.json',
      '/validator-locations.json'
    ];
    const GEO_CACHE_KEY = 'x1GeoCache';
    const GEO_CACHE_DURATION = 6 * 60 * 60 * 1000; // 6 hours
    
    let geoData = null;
    
    // Load pre-generated geo data from static JSON file
    async function loadStaticGeoData() {
      for (const url of GEO_DATA_URLS) {
        try {
          const response = await fetch(url + '?t=' + Date.now());
          if (response.ok) {
            const data = await response.json();
            if (data && data.locations && Object.keys(data.locations).length > 100) {
              geoData = data;
              console.log('Geo data loaded from:', url, '- Locations:', Object.keys(data.locations).length);
              return geoData;
            }
          }
        } catch (e) {
          console.log('Failed to load geo data from:', url);
        }
      }
      console.log('Static geo data not available, will use dynamic lookup');
      return null;
    }
    
    function getGeoCache() {
      try {
        const cached = JSON.parse(localStorage.getItem(GEO_CACHE_KEY) || '{}');
        return cached;
      } catch (e) {
        return { timestamp: 0, data: {} };
      }
    }
    
    function saveGeoCache(data) {
      try {
        localStorage.setItem(GEO_CACHE_KEY, JSON.stringify({
          timestamp: Date.now(),
          data: data
        }));
      } catch (e) { /* localStorage may fail due to quota limits - safe to ignore */ }
    }
    
    // Get geo data - prefers static file, falls back to API
    async function batchGeolocateIPs(ips, progressCallback) {
      // First, try to use static pre-generated data
      if (geoData && geoData.locations && Object.keys(geoData.locations).length > 50) {
        return geoData.locations;
      }
      
      // Check localStorage cache
      const cache = getGeoCache();
      const results = { ...cache.data };
      const cacheAge = Date.now() - (cache.timestamp || 0);
      const cacheAgeMinutes = Math.round(cacheAge / 1000 / 60);
      
      // If cache has good data and is fresh, use it
      if (cacheAge < GEO_CACHE_DURATION && Object.keys(results).length > 50) {
        return results;
      }
      
      // Find IPs not in cache
      const uncachedIPs = ips.filter(ip => !results[ip]);
      
      if (uncachedIPs.length === 0) {
        return results;
      }
      
      // Test API with known working IP
      let apiWorks = false;
      try {
        const testRes = await fetch('https://ipwho.is/8.8.8.8');
        const testData = await testRes.json();
        if (testData.success !== false && testData.latitude) {
          apiWorks = true;
        }
      } catch (e) {
        // API test failed
      }
      
      if (!apiWorks) {
        return results;
      }
      
      // Process IPs one at a time with delays to avoid rate limits
      let successCount = 0;
      const maxToProcess = Math.min(uncachedIPs.length, 500); // Limit to avoid long waits
      
      for (let i = 0; i < maxToProcess; i++) {
        const ip = uncachedIPs[i];
        
        try {
          const res = await fetch('https://ipwho.is/' + ip);
          const data = await res.json();
          
          if (data.success !== false && data.latitude && data.longitude) {
            results[ip] = {
              country: data.country,
              countryCode: data.country_code,
              city: data.city || 'Unknown',
              lat: data.latitude,
              lon: data.longitude
            };
            successCount++;
          }
        } catch (e) {
          // Skip failed lookups
        }
        
        // Progress callback
        if (progressCallback && (i % 10 === 0 || i === maxToProcess - 1)) {
          progressCallback(i + 1, maxToProcess, successCount);
        }
        
        // Save cache periodically
        if (successCount > 0 && successCount % 100 === 0) {
          saveGeoCache(results);
        }
        
        // Delay between requests (ipwho.is allows ~1000/day for free)
        await new Promise(r => setTimeout(r, 200));
      }
      
      // Final save
      if (successCount > 0) {
        saveGeoCache(results);
      }
      
      return results;
    }
    
    // Background refresh
    async function refreshGeoDataInBackground(ips) {
      const cache = getGeoCache();
      const results = { ...cache.data };
      
      const uncachedIPs = ips.filter(ip => !results[ip]);
      if (uncachedIPs.length === 0) return;
      
      const batchSize = 10;
      
      for (let i = 0; i < uncachedIPs.length; i += batchSize) {
        const batch = uncachedIPs.slice(i, i + batchSize);
        
        const promises = batch.map(async (ip) => {
          try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 5000);
            
            const res = await fetch(`https://ipwho.is/${ip}`, { signal: controller.signal });
            clearTimeout(timeout);
            
            if (res.ok) {
              const d = await res.json();
              if (d.success !== false && d.latitude && d.longitude) {
                results[ip] = {
                  country: d.country,
                  countryCode: d.country_code,
                  city: d.city || 'Unknown',
                  lat: d.latitude,
                  lon: d.longitude
                };
              }
            }
          } catch (e) { /* Individual IP lookup failed - continue with others */ }
        });
        
        await Promise.all(promises);
        
        if (i % 50 === 0) {
          saveGeoCache(results);
        }
        
        await new Promise(r => setTimeout(r, 1000));
      }
      
      saveGeoCache(results);
    }

    // Load and display validator locations
    async function loadValidatorLocations() {
      const loadingEl = document.getElementById('mapLoading');
      const hideLoading = () => { if (loadingEl) loadingEl.style.display = 'none'; };

      try {
        // First try to load pre-generated static data (auto-updated hourly by GitHub Actions)
        const staticData = await loadStaticGeoData();

        if (staticData && staticData.locations && Object.keys(staticData.locations).length > 100) {
          hideLoading();
          const records = Object.entries(staticData.locations).map(([ip, loc]) => loc && ({
            lat: loc.lat, lon: loc.lon, city: loc.city, country: loc.country,
            countryCode: loc.countryCode, count: loc.count || 1
          }));
          const points = aggregateGlobePoints(records);
          const countries = buildCountryIndex(points, staticData.countries);
          renderGlobeData(points, countries);
          return;
        }

        // Fall back to dynamic loading: gossip IPs from the RPC + ipwho.is
        const nodes = await getClusterNodesWithIPs();

        if (!nodes || nodes.length === 0) {
          hideLoading();
          document.getElementById('countryList').innerHTML = '<div class="map-loading-text">No validator data available</div>';
          return;
        }

        // Extract unique public IPs
        const ipSet = new Set();
        const nodeMap = {}; // IP -> node info

        nodes.forEach(node => {
          if (node.gossip) {
            const ip = node.gossip.split(':')[0];
            if (ip && !ip.startsWith('127.') && !ip.startsWith('10.') && !ip.startsWith('192.168.') && !ip.startsWith('0.')) {
              ipSet.add(ip);
              if (!nodeMap[ip]) nodeMap[ip] = [];
              nodeMap[ip].push(node);
            }
          }
        });

        const uniqueIPs = Array.from(ipSet);
        const loadingTextEl = document.querySelector('#mapLoading .map-loading-text');

        // Geolocate ALL IPs with progress updates
        const locations = await batchGeolocateIPs(uniqueIPs, (processed, total, found) => {
          if (loadingTextEl) {
            loadingTextEl.textContent = `Locating validators... ${found} found (${processed}/${total} IPs checked)`;
          }
        });

        hideLoading();

        const records = [];
        Object.entries(locations).forEach(([ip, loc]) => {
          if (!loc || !loc.lat || !loc.lon) return;
          const nodesAtIP = nodeMap[ip] || [];
          nodesAtIP.forEach(node => {
            const validator = allValidators.find(v => v.nodePubkey === node.pubkey);
            records.push({
              lat: loc.lat, lon: loc.lon, city: loc.city, country: loc.country,
              countryCode: loc.countryCode, count: 1,
              name: validator ? validator.name : null
            });
          });
        });

        const points = aggregateGlobePoints(records);
        const countries = buildCountryIndex(points, null);
        if (!Object.keys(countries).length) {
          document.getElementById('countryList').innerHTML = '<div class="map-loading-text" style="padding: 1rem;">Could not load location data. Network nodes exist but geolocation is unavailable.</div>';
          return;
        }
        renderGlobeData(points, countries);

      } catch (err) {
        console.error('Error loading validator locations:', err);
        hideLoading();
        document.getElementById('countryList').innerHTML = '<div class="map-loading-text">Error loading data</div>';
      }
    }

    // Tab switching
