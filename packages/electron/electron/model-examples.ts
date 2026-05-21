// @ts-nocheck
export const MODEL_EXAMPLES = {
  defaultExampleId: 'mounting_plate',
  examples: [
    {
      id: 'mounting_plate',
      partName: 'mounting_plate',
      defaultName: 'mounting_plate',
      defaultDescriptionKey: 'wizardDefaultDescription',
      defaultDescription: 'Parametric mounting plate with four M4 holes',
      kind: 'mounting_plate_assembly',
      fields: [
        { key: 'length', labelKey: 'wizardLength', defaultValue: 72, min: 20, max: 300, step: 1 },
        { key: 'width', labelKey: 'wizardWidth', defaultValue: 44, min: 20, max: 240, step: 1 },
        { key: 'thickness', labelKey: 'wizardThickness', defaultValue: 6, min: 1, max: 40, step: 0.5 },
        { key: 'hole_spacing_x', labelKey: 'wizardHoleSpacingX', defaultValue: 52, min: 8, max: 280, step: 1 },
        { key: 'hole_spacing_y', labelKey: 'wizardHoleSpacingY', defaultValue: 28, min: 8, max: 220, step: 1 },
        { key: 'corner_radius', labelKey: 'wizardCornerRadius', defaultValue: 5, min: 0, max: 40, step: 0.5 }
      ]
    },
    {
      id: 'l_bracket',
      partName: 'l_bracket',
      defaultName: 'l_bracket',
      defaultDescriptionKey: 'wizardLBracketDefaultDescription',
      defaultDescription: 'Parametric L bracket with bolt holes on both legs',
      kind: 'single_part',
      fields: [
        { key: 'length', labelKey: 'wizardLegLength', defaultValue: 64, min: 24, max: 240, step: 1 },
        { key: 'height', labelKey: 'wizardHeight', defaultValue: 48, min: 20, max: 220, step: 1 },
        { key: 'width', labelKey: 'wizardWidth', defaultValue: 32, min: 16, max: 160, step: 1 },
        { key: 'thickness', labelKey: 'wizardThickness', defaultValue: 5, min: 1, max: 30, step: 0.5 },
        { key: 'hole_diameter', labelKey: 'wizardHoleDiameter', defaultValue: 5, min: 1, max: 24, step: 0.5 },
        { key: 'hole_offset', labelKey: 'wizardHoleOffset', defaultValue: 18, min: 4, max: 120, step: 1 }
      ]
    },
    {
      id: 'bearing_block',
      partName: 'bearing_block',
      defaultName: 'bearing_block',
      defaultDescriptionKey: 'wizardBearingBlockDefaultDescription',
      defaultDescription: 'Parametric bearing block with shaft bore and base mounting holes',
      kind: 'single_part',
      fields: [
        { key: 'length', labelKey: 'wizardLength', defaultValue: 72, min: 30, max: 220, step: 1 },
        { key: 'width', labelKey: 'wizardWidth', defaultValue: 34, min: 18, max: 140, step: 1 },
        { key: 'height', labelKey: 'wizardHeight', defaultValue: 42, min: 18, max: 160, step: 1 },
        { key: 'bore_diameter', labelKey: 'wizardBoreDiameter', defaultValue: 16, min: 4, max: 80, step: 0.5 },
        { key: 'mount_hole_spacing', labelKey: 'wizardMountHoleSpacing', defaultValue: 52, min: 12, max: 180, step: 1 },
        { key: 'mount_hole_diameter', labelKey: 'wizardMountHoleDiameter', defaultValue: 5, min: 1, max: 24, step: 0.5 }
      ]
    },
    {
      id: 'gear',
      partName: 'gear',
      defaultName: 'gear',
      defaultDescriptionKey: 'wizardGearDefaultDescription',
      defaultDescription: 'Parametric spur gear blank with editable teeth and bore',
      kind: 'single_part',
      fields: [
        { key: 'teeth', labelKey: 'wizardTeeth', defaultValue: 24, min: 8, max: 96, step: 1 },
        { key: 'pitch_radius', labelKey: 'wizardPitchRadius', defaultValue: 28, min: 8, max: 120, step: 1 },
        { key: 'thickness', labelKey: 'wizardThickness', defaultValue: 8, min: 1, max: 50, step: 0.5 },
        { key: 'bore_diameter', labelKey: 'wizardBoreDiameter', defaultValue: 8, min: 1, max: 80, step: 0.5 },
        { key: 'hub_diameter', labelKey: 'wizardHubDiameter', defaultValue: 22, min: 4, max: 120, step: 1 },
        { key: 'tooth_depth', labelKey: 'wizardToothDepth', defaultValue: 3, min: 0.5, max: 16, step: 0.5 }
      ]
    },
    {
      id: 'knob',
      partName: 'knob',
      defaultName: 'knob',
      defaultDescriptionKey: 'wizardKnobDefaultDescription',
      defaultDescription: 'Parametric control knob with grip grooves and center bore',
      kind: 'single_part',
      fields: [
        { key: 'diameter', labelKey: 'wizardDiameter', defaultValue: 36, min: 12, max: 120, step: 1 },
        { key: 'height', labelKey: 'wizardHeight', defaultValue: 18, min: 6, max: 80, step: 1 },
        { key: 'bore_diameter', labelKey: 'wizardBoreDiameter', defaultValue: 6, min: 1, max: 50, step: 0.5 },
        { key: 'groove_count', labelKey: 'wizardGrooveCount', defaultValue: 18, min: 6, max: 64, step: 1 },
        { key: 'groove_depth', labelKey: 'wizardGrooveDepth', defaultValue: 1.6, min: 0.2, max: 8, step: 0.2 },
        { key: 'top_chamfer', labelKey: 'wizardTopChamfer', defaultValue: 0.6, min: 0, max: 8, step: 0.2 }
      ]
    }
  ]
};
