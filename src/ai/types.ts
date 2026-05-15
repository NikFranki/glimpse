export interface AISkill {
  readonly name: string;
  isAvailable(): Promise<boolean>;
  run(prompt: string): Promise<string>;
}

export interface AIRawOutputComponent {
  name: string;
  usage: string;
  deps?: string[];
  props?: string[];
  state?: string[];
  methods?: string[];
  jsx?: string;
  behaviors?: string[];
}

export interface AIRawOutput {
  responsibilities: string[];
  dataFlow: Array<{ feature: string; components: AIRawOutputComponent[] }>;
  exportDescriptions: Record<string, string>;
}
