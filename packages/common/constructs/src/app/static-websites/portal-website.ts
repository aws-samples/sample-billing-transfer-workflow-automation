import * as url from 'url';
import { Construct } from 'constructs';
import { StaticWebsite } from '../../core/index.js';

export class PortalWebsite extends StaticWebsite {
  constructor(scope: Construct, id: string) {
    super(scope, id, {
      websiteName: 'PortalWebsite',
      websiteFilePath: url.fileURLToPath(
        new URL(
          '../../../../../../dist/packages/portal-website/bundle',
          import.meta.url,
        ),
      ),
    });
  }
}
