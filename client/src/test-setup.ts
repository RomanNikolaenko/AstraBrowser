// Popover API у jsdom немає: :popover-open не збігається ніколи, і стилі jsdom ховають кожну панель (display: none). А
// прихованого jsdom не фокусує (з 30.1.2) — тож панелі показуємо, як їх показав би showPopover() у браузері.
// !important — бо свої стилі jsdom ставить не нижче за стилі сторінки, а лише за специфічністю.
const popovers = document.createElement('style');
popovers.textContent = '[popover] { display: block !important; }';
document.head.append(popovers);
