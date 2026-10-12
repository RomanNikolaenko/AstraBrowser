import { LEGAL_CONTACT } from '../contact';
import { LegalDocument } from '../legal-document';

const UPDATED = 'Last updated October 12, 2026';

export const TERMS: LegalDocument = {
  title: 'Terms of Use',
  updated: UPDATED,
  intro: [
    'These terms cover the Astra Browser web browser for Windows and the Astra account the browser uses to sync your data between computers. By creating an account or using the browser, you agree to them.',
    `The service is provided by the developer of Astra Browser. Questions about these terms: ${LEGAL_CONTACT}.`,
  ],
  sections: [
    {
      heading: '1. What Astra Browser is',
      blocks: [
        'Astra Browser is a free web browser. It shows websites through Microsoft Edge WebView2 and includes bookmarks, history, notes, a password manager, an ad blocker, tracking protection and sync.',
        'The browser can only be used with an Astra account: it holds your data for sync.',
      ],
    },
    {
      heading: '2. Your account',
      blocks: [
        [
          'Use an email address you have access to: confirmation codes and security emails are sent there.',
          'Keep your password secret. Everything done with your account is considered done by you until you tell us about unauthorized access.',
          'Your account is personal: don’t share it with other people.',
          'You can delete your account at any time: “Manage profile” → “Delete account”. All synced data is removed from the server with it.',
        ],
        'You must be at least 16 to create an account; younger people need the consent of a parent or guardian.',
      ],
    },
    {
      heading: '3. Acceptable use',
      blocks: [
        'You must not:',
        [
          'use the browser or the sync service to break the law or violate the rights of others;',
          'try to access other people’s accounts or data, bypass the service’s protection, overload it or break into it;',
          'use sync to store data unrelated to the browser or unlawful content;',
          'create accounts automatically or send mass requests to the service.',
        ],
      ],
    },
    {
      heading: '4. Third-party websites and services',
      blocks: [
        'Websites you open belong to their owners, who are responsible for their content and operation; their own terms apply.',
        'The ad blocker and tracking protection change what websites load, so some of them may work differently. Both can be turned off for a single site.',
        'Some browser features rely on services of other companies: your search engine and its suggestions, Google Translate, Microsoft Defender SmartScreen and your DNS over HTTPS provider. When you use them, their terms apply as well. What is sent to them is described in the Privacy Policy.',
      ],
    },
    {
      heading: '5. Updates',
      blocks: [
        'The browser checks whether a new version is out and offers to install it with the “Update Astra Browser” item in the menu. Updates may change, add or remove browser features.',
      ],
    },
    {
      heading: '6. Rights to the browser',
      blocks: [
        'The Astra Browser name, logo and code belong to the developer. You may install and use the browser for yourself; these terms grant no other rights to it. Microsoft Edge WebView2 and other third-party components are distributed under their own licenses.',
      ],
    },
    {
      heading: '7. No warranty',
      blocks: [
        'The browser and sync are provided “as is”. We work to keep everything running, but we don’t guarantee that the service will always be available, error-free or free of data loss. Keep important data elsewhere too — for example, export your bookmarks (“Manage profile” → “Export bookmarks”).',
      ],
    },
    {
      heading: '8. Liability',
      blocks: [
        'To the extent permitted by law, the developer is not liable for indirect damages, lost profits or data loss related to using, or being unable to use, the browser or the sync service. Your consumer rights that the law does not allow to be limited remain in force.',
      ],
    },
    {
      heading: '9. Termination',
      blocks: [
        'You can stop using the service and delete your account at any time. We may suspend or delete an account that violates these terms. If sync is ever shut down, we will tell you in advance so you can save your data.',
      ],
    },
    {
      heading: '10. Changes to these terms',
      blocks: [
        'We may change these terms. A new version appears in the browser with its date at the top; we will let you know about significant changes in the browser or by email. If you disagree with the new version, you can delete your account; using the service after the change means you accept it.',
      ],
    },
    {
      heading: '11. Governing law',
      blocks: [
        'These terms are governed by the laws of Ukraine. Mandatory consumer protection rules of the country where you live remain in force.',
        `Contact us: ${LEGAL_CONTACT}.`,
      ],
    },
  ],
};

export const PRIVACY: LegalDocument = {
  title: 'Privacy Policy',
  updated: UPDATED,
  intro: [
    'This policy explains what data Astra Browser and the Astra account process, why, where it is stored and how you can control it.',
    `The developer of Astra Browser is responsible for processing your data. Questions and requests about your data: ${LEGAL_CONTACT}.`,
  ],
  sections: [
    {
      heading: '1. In short',
      blocks: [
        [
          'We don’t sell your data, show ads or collect statistics about how you use the browser.',
          'Site passwords are encrypted on your computer with a key derived from your account password: they can’t be read on the server.',
          'You can change what is sent where in the settings — see below for where exactly.',
        ],
      ],
    },
    {
      heading: '2. Your account',
      blocks: [
        'For your account we store your email address, your name (if you entered one) and your password in a form it cannot be recovered from. The email address is used for signing in, confirmation codes and account security emails.',
      ],
    },
    {
      heading: '3. Sync',
      blocks: [
        'To keep your data on all your computers, the browser stores on the server:',
        [
          'bookmarks and notes;',
          'browsing history (page addresses and titles) for the period chosen in the settings, 90 days by default;',
          'your profile: name, avatar color and photo;',
          'browser settings and per-site choices (permissions, tracking protection exceptions, pop-ups, apps for links);',
          'site passwords — only in encrypted form, as described above.',
        ],
        'Everything except passwords is stored on the server without that encryption. Database rules let only your account see these records, but the service administrator technically has access to the database. We look at them only when running the service or the law requires it.',
      ],
    },
    {
      heading: '4. Security emails',
      blocks: [
        'We send emails when your account is created, when someone signs in to it for the first time on a new computer or from an unfamiliar place, when the password or email address is changed and when the account is deleted. For this, the server keeps the last 10 IP addresses your account signed in from, and the email shows the country (based on the IP address) and the computer name.',
      ],
    },
    {
      heading: '5. Data on your computer',
      blocks: [
        'Cookies, cache and site data, history, downloads and settings are stored on your computer. Saved passwords are encrypted there with Windows. The browser keeps an error log to find crashes — it stays on your computer and contains no page addresses. You can clear this data in “Settings” → “Clear browsing data”.',
        'Private and guest windows keep none of it after they are closed.',
      ],
    },
    {
      heading: '6. What other companies see',
      blocks: [
        [
          'Websites you open see your IP address and what you do on them, as with any browser. The browser asks them not to sell or share your data (the Global Privacy Control signal; turn it off in “Settings” → “Privacy”).',
          'Your search engine (Google, DuckDuckGo or Bing — whichever you choose) receives your searches and, if suggestions are on, what you type in the address bar (turn them off in “Settings” → “Search”).',
          'Microsoft Defender SmartScreen receives the addresses of sites and downloads to check them for phishing and malware (turn it off in “Settings” → “Privacy”).',
          'Google Translate receives a page or text when you ask to translate it.',
          'Your DNS over HTTPS provider sees the names of the sites you open if you chose one in the settings; by default, lookups go to your network’s DNS.',
          'The ad blocker and tracking protection download rule lists (EasyList, AdGuard, uBlock Origin and others), and the browser checks GitHub for updates. These requests contain none of your data except your IP address.',
        ],
      ],
    },
    {
      heading: '7. Who stores the data',
      blocks: [
        'Your account and synced data are stored by Supabase in a data center in Frankfurt (Germany, EU). Emails are sent through an email delivery provider. Both process data only to run the service.',
      ],
    },
    {
      heading: '8. Why and on what basis',
      blocks: [
        [
          'Your account, sync and security emails — to provide the service you agreed to (the Terms of Use) and to protect your account.',
          'Search suggestions, SmartScreen, translation and DNS over HTTPS — because you use them; you can turn them off or not use them.',
          'Answering requests and meeting legal obligations — when the law requires it.',
        ],
      ],
    },
    {
      heading: '9. How long we keep data',
      blocks: [
        'Account and sync data — as long as the account exists. History older than the chosen period is removed automatically; deleted bookmarks and notes are kept as deletion markers for up to 30 days so the deletion reaches all your computers. When you delete your account, its data is removed from the server immediately; it may remain in the provider’s backups for a short time until they are replaced.',
      ],
    },
    {
      heading: '10. Your rights',
      blocks: [
        'You can:',
        [
          'view and change your data in the browser, and your name, email address and password in “Manage profile”;',
          'export your bookmarks to an HTML file;',
          'delete your account together with all synced data;',
          `ask for a copy of your data, its correction, deletion or restricted processing, or object to processing — by writing to ${LEGAL_CONTACT};`,
          'complain to the Ukrainian Parliament Commissioner for Human Rights or to the data protection authority of your country.',
        ],
      ],
    },
    {
      heading: '11. Security',
      blocks: [
        'Connections to the server are encrypted (HTTPS), site passwords are encrypted on your computer, and deleting your account requires a freshly entered password. No protection is absolute: if you notice anything suspicious, change your password and write to us.',
      ],
    },
    {
      heading: '12. Children',
      blocks: [
        'The browser is not intended for children under 16 without the consent of a parent or guardian. If you believe a child created an account without such consent, write to us and we will delete it.',
      ],
    },
    {
      heading: '13. Changes to this policy',
      blocks: [
        'A new version appears in the browser with its date at the top; we will let you know about significant changes in the browser or by email.',
      ],
    },
  ],
};
