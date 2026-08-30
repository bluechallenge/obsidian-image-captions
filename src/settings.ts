import { App, PluginSettingTab, SettingDefinitionItem } from 'obsidian'
import ImageCaptions from './main'

export interface CaptionSettings {
  captionRegex: string;
}

export const DEFAULT_SETTINGS: CaptionSettings = {
  captionRegex: ''
}

const captionRegexDesc = 'For advanced caption parsing, you can add a regex here. The first capturing group will be used as the image caption. ' +
  'This is useful in situations where you might have another plugin or theme adding text to the caption area which you want to strip out. ' +
  'The placeholder example would be used to exclude everything following a pipe character (if one exists).'

export class CaptionSettingTab extends PluginSettingTab {
  plugin: ImageCaptions

  constructor (app: App, plugin: ImageCaptions) {
    super(app, plugin)
    this.plugin = plugin
  }

  getSettingDefinitions (): SettingDefinitionItem[] {
    return [
      {
        name: 'Caption regex',
        desc: captionRegexDesc,
        control: {
          type: 'text',
          key: 'captionRegex',
          placeholder: '^([^|]+)',
          defaultValue: '',
          validate: value => {
            try {
              RegExp(value)
            } catch {
              return 'Not a valid regular expression.'
            }
          }
        }
      }
    ]
  }
}
