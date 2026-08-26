import { PluginContext } from 'molstar/lib/mol-plugin/context';
import { StructureElement, StructureProperties, Unit } from 'molstar/lib/mol-model/structure';
import { MolScriptBuilder as MS } from 'molstar/lib/mol-script/language/builder';
import {
  StructureSelectionQueries, StructureSelectionQuery,
} from 'molstar/lib/mol-plugin-state/helpers/structure-selection-query';
import { createStructureColorThemeParams } from 'molstar/lib/mol-plugin-state/helpers/structure-representation-params';
import { setSubtreeVisibility } from 'molstar/lib/mol-plugin/behavior/static/state';
import { Color } from 'molstar/lib/mol-util/color';

const CHAIN_COLORS = [
  '#5cc8ff', '#ff9f6e', '#70dc9d', '#c59cff', '#ffd166', '#ff7f9f',
  '#65d6ce', '#a9c76c', '#f49dd4', '#91a7ff', '#e9b872', '#72d1a8',
];

const REPRESENTATIONS = {
  cartoon: { type: 'cartoon', component: 'chain', params: { quality: 'auto', ignoreHydrogens: true } },
  surface: { type: 'molecular-surface', component: 'chain', params: { quality: 'auto', ignoreHydrogens: true, alpha: 0.72 } },
  sidechain: { type: 'ball-and-stick', component: 'sidechain', params: { quality: 'auto', ignoreHydrogens: true } },
};

function hexColor(value) {
  return Color(Number.parseInt(String(value).replace(/^#/, ''), 16));
}

function chainExpression(labelId) {
  return MS.struct.generator.atomGroups({
    'chain-test': MS.core.rel.eq([MS.ammp('label_asym_id'), labelId]),
  });
}

function extractChains(structure) {
  const found = new Map();
  for (const unit of structure.units) {
    if (!Unit.isAtomic(unit) || !unit.elements.length) continue;
    const location = StructureElement.Location.create(structure, unit, unit.elements[0]);
    const labelId = StructureProperties.chain.label_asym_id(location);
    const authId = StructureProperties.chain.auth_asym_id(location);
    if (labelId && !found.has(labelId)) found.set(labelId, { labelId, authId: authId || labelId });
  }
  const chains = [...found.values()];
  const authCounts = new Map();
  for (const chain of chains) authCounts.set(chain.authId, (authCounts.get(chain.authId) || 0) + 1);
  return chains.map((chain, index) => ({
    ...chain,
    index,
    label: authCounts.get(chain.authId) > 1 ? `${chain.authId} · ${chain.labelId}` : chain.authId,
    color: CHAIN_COLORS[index % CHAIN_COLORS.length],
    modes: { cartoon: true, surface: false, sidechain: false },
    component: null,
    sidechainComponent: null,
    representations: {},
  }));
}

function control(tag, className, text) {
  const element = document.createElement(tag);
  element.className = className;
  if (text != null) element.textContent = text;
  return element;
}

function modeState(chains, mode) {
  if (chains.every((chain) => chain.modes[mode])) return 'true';
  if (chains.every((chain) => !chain.modes[mode])) return 'false';
  return 'mixed';
}

export async function createStructurePreview(host, { data, format, name }) {
  let disposed = false;
  let operation = Promise.resolve();
  const plugin = new PluginContext({ actions: [], behaviors: [], animations: [] });

  const shell = control('div', 'structure-preview');
  const toolbar = control('div', 'structure-controls');
  const viewport = control('div', 'structure-viewport');
  const canvas = control('canvas', 'structure-canvas');
  const hint = control('div', 'structure-hint', 'Drag to rotate · scroll to zoom');
  const status = control('div', 'structure-status', 'Preparing Mol*…');
  canvas.setAttribute('aria-label', `Interactive molecular structure preview of ${name}`);
  canvas.tabIndex = 0;
  viewport.append(canvas, hint, status);
  shell.append(toolbar, viewport);
  host.replaceChildren(shell);

  const resizeObserver = new ResizeObserver(() => plugin.handleResize());
  resizeObserver.observe(viewport);

  try {
    await plugin.init();
    if (disposed) return { dispose() {} };
    const initialized = await plugin.initViewerAsync(canvas, viewport);
    if (!initialized) throw new Error('WebGL could not initialize the molecular preview.');
    plugin.canvas3d?.setProps({
      renderer: { backgroundColor: Color(0x080b10) },
      camera: { helper: { axes: { name: 'off', params: {} } } },
    });

    status.textContent = 'Parsing structure…';
    const raw = await plugin.builders.data.rawData({ data, label: name });
    const trajectory = await plugin.builders.structure.parseTrajectory(raw, format === 'pdb' ? 'pdb' : 'mmcif');
    const model = await plugin.builders.structure.createModel(trajectory);
    const structure = await plugin.builders.structure.createStructure(model);
    const structureData = structure.cell?.obj?.data;
    if (!structureData?.elementCount) throw new Error('No atoms were found in this structure.');
    const chains = extractChains(structureData);
    if (!chains.length) throw new Error('No atomistic chains were found in this structure.');

    status.textContent = `Building ${chains.length} chain${chains.length === 1 ? '' : 's'}…`;
    for (const chain of chains) {
      const expression = chainExpression(chain.labelId);
      chain.component = await plugin.builders.structure.tryCreateComponentFromSelection(
        structure,
        StructureSelectionQuery(`Chain ${chain.label}`, expression),
        `webspider-chain-${chain.index}`,
        { label: `Chain ${chain.label}` },
      );
      if (chain.component) {
        chain.representations.cartoon = await plugin.builders.structure.representation.addRepresentation(chain.component, {
          type: REPRESENTATIONS.cartoon.type,
          typeParams: REPRESENTATIONS.cartoon.params,
          color: 'uniform',
          colorParams: { value: hexColor(chain.color) },
        }, { tag: `webspider-cartoon-${chain.index}` });
      }
    }
    if (disposed) return { dispose() {} };

    const chainLabel = control('label', 'structure-control-group');
    chainLabel.append(control('span', '', 'Chain'));
    const chainSelect = control('select', 'structure-chain-select');
    chainSelect.setAttribute('aria-label', 'Chain to edit');
    const allOption = document.createElement('option');
    allOption.value = 'all';
    allOption.textContent = `All (${chains.length})`;
    chainSelect.append(allOption);
    for (const chain of chains) {
      const option = document.createElement('option');
      option.value = String(chain.index);
      option.textContent = chain.label;
      chainSelect.append(option);
    }
    chainLabel.append(chainSelect);

    const colorLabel = control('label', 'structure-control-group structure-color-group');
    colorLabel.append(control('span', '', 'Color'));
    const colorInput = control('input', 'structure-color-input');
    colorInput.type = 'color';
    colorInput.setAttribute('aria-label', 'Selected chain color');
    colorLabel.append(colorInput);
    const distinctButton = control('button', 'structure-distinct', 'Distinct chains');
    distinctButton.type = 'button';
    distinctButton.title = 'Restore a distinct color for every chain';

    const modeButtons = {};
    const modeGroup = control('div', 'structure-mode-group');
    for (const [mode, label] of [['cartoon', 'Cartoon'], ['surface', 'Surface'], ['sidechain', 'Side chains']]) {
      const button = control('button', 'structure-toggle', label);
      button.type = 'button';
      button.dataset.structureMode = mode;
      modeButtons[mode] = button;
      modeGroup.append(button);
    }
    toolbar.replaceChildren(chainLabel, colorLabel, distinctButton, modeGroup);

    const selectedChains = () => chainSelect.value === 'all' ? chains : [chains[Number(chainSelect.value)]].filter(Boolean);
    const updateControls = () => {
      const selected = selectedChains();
      const colors = new Set(selected.map((chain) => chain.color));
      colorInput.value = selected[0]?.color || '#cccccc';
      colorInput.classList.toggle('mixed', colors.size > 1);
      colorInput.title = colors.size > 1 ? 'Chains currently have distinct colors; choosing a color applies it to all selected chains.' : 'Selected chain color';
      for (const [mode, button] of Object.entries(modeButtons)) {
        const pressed = modeState(selected, mode);
        button.setAttribute('aria-pressed', pressed);
        button.classList.toggle('selected', pressed === 'true');
        button.classList.toggle('mixed', pressed === 'mixed');
      }
    };

    const ensureRepresentation = async (chain, mode) => {
      if (chain.representations[mode]) return chain.representations[mode];
      const definition = REPRESENTATIONS[mode];
      let component = chain.component;
      if (definition.component === 'sidechain' && !chain.sidechainComponent) {
        const expression = MS.struct.modifier.intersectBy({
          0: chainExpression(chain.labelId),
          by: StructureSelectionQueries.sidechainWithTrace.expression,
        });
        chain.sidechainComponent = await plugin.builders.structure.tryCreateComponentFromSelection(
          structure,
          StructureSelectionQuery(`Side chains ${chain.label}`, expression),
          `webspider-sidechains-${chain.index}`,
          { label: `Side chains ${chain.label}` },
        );
      }
      if (definition.component === 'sidechain') component = chain.sidechainComponent;
      if (!component) return null;
      chain.representations[mode] = await plugin.builders.structure.representation.addRepresentation(component, {
        type: definition.type,
        typeParams: definition.params,
        color: 'uniform',
        colorParams: { value: hexColor(chain.color) },
      }, { tag: `webspider-${mode}-${chain.index}` });
      return chain.representations[mode];
    };

    const setMode = async (chain, mode, visible) => {
      chain.modes[mode] = visible;
      const representation = visible ? await ensureRepresentation(chain, mode) : chain.representations[mode];
      if (representation) setSubtreeVisibility(plugin.state.data, representation.ref, !visible);
    };

    const setColors = async (selected, colors) => {
      const update = plugin.state.data.build();
      for (let index = 0; index < selected.length; index += 1) {
        const chain = selected[index];
        chain.color = colors[index];
        for (const [mode, representation] of Object.entries(chain.representations)) {
          if (!representation?.cell?.transform?.params) continue;
          const component = mode === 'sidechain' ? chain.sidechainComponent : chain.component;
          const componentData = component?.cell?.obj?.data;
          update.to(representation.ref).update((previous) => {
            previous.colorTheme = createStructureColorThemeParams(
              plugin, componentData, previous.type?.name || REPRESENTATIONS[mode].type,
              'uniform', { value: hexColor(chain.color) },
            );
          });
        }
      }
      await update.commit();
    };

    const enqueue = (work) => {
      operation = operation.then(async () => {
        toolbar.classList.add('busy');
        try { await work(); } finally {
          toolbar.classList.remove('busy');
          updateControls();
        }
      }).catch((error) => {
        status.hidden = false;
        status.textContent = error?.message || 'The molecular preview could not update.';
      });
      return operation;
    };

    chainSelect.addEventListener('change', updateControls);
    colorInput.addEventListener('change', () => enqueue(async () => {
      const selected = selectedChains();
      await setColors(selected, selected.map(() => colorInput.value));
    }));
    distinctButton.addEventListener('click', () => enqueue(async () => {
      await setColors(chains, chains.map((chain) => CHAIN_COLORS[chain.index % CHAIN_COLORS.length]));
    }));
    modeGroup.addEventListener('click', (event) => {
      const button = event.target.closest('[data-structure-mode]');
      if (!button) return;
      const mode = button.dataset.structureMode;
      enqueue(async () => {
        const selected = selectedChains();
        const visible = !selected.every((chain) => chain.modes[mode]);
        for (const chain of selected) await setMode(chain, mode, visible);
      });
    });

    updateControls();
    status.hidden = true;
    plugin.managers.camera.focusObject({ targets: [{ targetRef: structure.ref, extraRadius: 3 }], durationMs: 0 });

    return {
      chains: chains.map(({ label, labelId, authId }) => ({ label, labelId, authId })),
      dispose() {
        if (disposed) return;
        disposed = true;
        resizeObserver.disconnect();
        plugin.dispose();
      },
    };
  } catch (error) {
    resizeObserver.disconnect();
    plugin.dispose();
    status.hidden = false;
    status.textContent = error?.message || 'This structure could not be previewed.';
    throw error;
  }
}
