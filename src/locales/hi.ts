/**
 * Hindi interface text: everyday Hindi in Devanagari, the same shape as en.ts.
 * Words people actually use for a night out are kept ("इवेंट", "टिकट",
 * "बुकिंग", "वीकेंड") instead of formal coinages.
 */
import type { Faq, FaqInput, HubKind, HubText, HubTextInput, Messages, SummaryInput } from "./en";

const hai = (n: number) => (n === 1 ? "है" : "हैं");
const listJoin = (items: string[]) => (items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} और ${items[items.length - 1]}`);
const PERIOD: Partial<Record<HubKind, string>> = { home: "इस हफ़्ते", today: "आज", "this-weekend": "इस वीकेंड", "this-week": "इस हफ़्ते" };

export const hi: Messages = {
  site: {
    description: "भारतीय शहरों में क्या हो रहा है: कॉन्सर्ट, कॉमेडी, थिएटर, वर्कशॉप और बहुत कुछ, हर लिस्टिंग के स्रोत और जाँच की तारीख़ के साथ।",
    skip: "सीधे मुख्य हिस्से पर जाएँ",
    navAbout: "हमारे बारे में",
    navVerify: "हम कैसे जाँचते हैं",
    navLabel: "साइट",
    footerLabel: "फ़ुटर",
    footer: (name: string) => `${name} इवेंट की जानकारी नामित सार्वजनिक स्रोतों से लेता है और आधिकारिक बुकिंग पेज का लिंक देता है। यह टिकट नहीं बेचता।`,
    footerVerify: "हम इवेंट कैसे जुटाते और जाँचते हैं",
    footerCorrections: "सुधार और हटाने का अनुरोध",
    footerChangelog: "बदलावों की सूची",
    switchTo: "Read in English",
    breadcrumb: "आप यहाँ हैं",
  },
  common: {
    updated: "अपडेट किया गया",
    cancelled: "रद्द",
    postponed: "स्थगित",
    freeEntry: "फ़्री एंट्री",
    events: (n: number) => `${n} इवेंट`,
    faqHeading: "लोग ये सवाल पूछते हैं",
    sourcesHeading: "इस पेज के स्रोत",
    sourcesNote: "ऊपर दी गई हर जानकारी यहाँ दिए गए पेजों से ली गई है और हमारे अपने शब्दों में लिखी गई है।",
    usedFor: "इसके लिए इस्तेमाल",
    factLabels: {
      address: "पता", area: "इलाक़ा", "type of venue": "जगह का प्रकार", capacity: "क्षमता", parking: "पार्किंग",
      "nearest landmarks": "पास की पहचान", "how to reach": "कैसे पहुँचें", about: "परिचय", "who they are": "ये कौन हैं",
      "genre or form": "शैली", from: "कहाँ से", "notable work": "चर्चित काम", "what they run": "क्या आयोजित करते हैं",
      "active since": "कब से सक्रिय", "official instagram link": "आधिकारिक इंस्टाग्राम लिंक", "official website link": "आधिकारिक वेबसाइट लिंक",
      "official youtube link": "आधिकारिक यूट्यूब लिंक", "official spotify link": "आधिकारिक स्पॉटिफ़ाई लिंक",
      "official facebook link": "आधिकारिक फ़ेसबुक लिंक", "official x link": "आधिकारिक X लिंक", "official apple music link": "आधिकारिक ऐपल म्यूज़िक लिंक",
    },
    officialLinks: "आधिकारिक लिंक",
    categories: {
      music: "म्यूज़िक", comedy: "कॉमेडी", theatre: "थिएटर", dance: "डांस", workshops: "वर्कशॉप", kids: "बच्चों के लिए", food: "खाना-पीना",
      festivals: "फ़ेस्टिवल", "religious-and-cultural": "धार्मिक और सांस्कृतिक", "sports-and-fitness": "खेल और फ़िटनेस", exhibitions: "प्रदर्शनी",
      "college-events": "कॉलेज इवेंट", "business-and-networking": "बिज़नेस और नेटवर्किंग", nightlife: "नाइटलाइफ़",
    },
  },
  nav: {
    listings: (city: string) => `${city} की लिस्टिंग`,
    thisWeek: "इस हफ़्ते", today: "आज", thisWeekend: "इस वीकेंड", past: "पिछले इवेंट", search: "खोजें",
  },
  hub: {
    listHeading: (kind: HubKind) => (kind === "past" ? "पिछले इवेंट" : kind === "home" ? "इस हफ़्ते" : "लिस्टिंग"),
    nothing: "यहाँ अभी कुछ लिस्टेड नहीं है।",
    seeAll: (city: string) => `${city} में आगे होने वाले सभी इवेंट देखें`,
    calendarFeed: "कैलेंडर फ़ीड (ICS)",
    jsonFeed: "JSON फ़ीड",
    byArea: "इलाक़े के हिसाब से",
    eventLine: (title: string, venue: string | null, when: string) => `${title}${venue ? `, ${venue} में` : ""} (${when})`,
    text(i: HubTextInput): HubText {
      const c = i.city;
      switch (i.kind) {
        case "area":
          return { heading: `${i.area}, ${c} में इवेंट`, title: `${i.area}, ${c} में इवेंट`,
            description: `${i.area}, ${c} की जगहों पर आने वाले इवेंट: तारीख़, क़ीमत, स्रोत और बुकिंग लिंक के साथ।` };
        case "home":
          return { heading: `${c} में इवेंट`, title: `${c} में इवेंट: इस हफ़्ते क्या हो रहा है`,
            description: `${c}, ${i.state} में कॉन्सर्ट, कॉमेडी, थिएटर, वर्कशॉप और सामुदायिक इवेंट। हर लिस्टिंग में उसका स्रोत और आख़िरी जाँच की तारीख़ दी गई है।` };
        case "today":
          return { heading: `आज ${c} में इवेंट`, title: `आज ${c} में इवेंट`,
            description: `आज, ${i.today} को ${c} में क्या हो रहा है: गिग, कॉमेडी, थिएटर, वर्कशॉप और बहुत कुछ, समय, जगह और बुकिंग लिंक के साथ।` };
        case "this-weekend":
          return { heading: `इस वीकेंड ${c} में इवेंट`, title: `इस वीकेंड ${c} में इवेंट`,
            description: `इस वीकेंड, ${i.from} से ${i.to} तक ${c} में क्या हो रहा है: हर लिस्टेड इवेंट समय, जगह, क़ीमत और बुकिंग लिंक के साथ।` };
        case "this-week":
          return { heading: `इस हफ़्ते ${c} में इवेंट`, title: `इस हफ़्ते ${c} में इवेंट`,
            description: `${i.today} से अगले सात दिनों में ${c} के सभी लिस्टेड इवेंट: समय, जगह, क़ीमत और बुकिंग लिंक के साथ।` };
        case "past":
          return { heading: `${c} के पिछले इवेंट`, title: `${c} के पिछले इवेंट`,
            description: `${c} में हो चुके इवेंट का संग्रह: जगह, कलाकार और स्रोत के साथ।` };
        default:
          return { heading: `${c} में ${i.category} इवेंट`, title: `${c} में ${i.category} इवेंट`,
            description: `${c} में आने वाले ${i.category} इवेंट: तारीख़, जगह, क़ीमत, स्रोत और बुकिंग लिंक के साथ।` };
      }
    },
    summary(i: SummaryInput): string {
      const n = i.count;
      if (i.kind === "past") {
        return n === 0
          ? `${i.city} के संग्रह में अभी कोई पिछला इवेंट नहीं है। इवेंट हो जाने के बाद यहाँ आ जाते हैं।`
          : `इस संग्रह में ${i.city} में हो चुके ${n} इवेंट ${hai(n)}, सबसे नए सबसे ऊपर। हर इवेंट के साथ उसकी जगह, कलाकार और मूल स्रोत दर्ज है।`;
      }
      const what = i.kind === "category" ? `${i.category} इवेंट` : "इवेंट";
      const where = i.kind === "area" ? `${i.area}, ${i.city}` : i.city;
      const period = PERIOD[i.kind];
      if (n === 0) {
        const first = `${where} में ${period ? `${period} के लिए` : "आने वाले हफ़्तों के लिए"} फ़िलहाल कोई ${what} लिस्टेड नहीं है।`;
        return i.next ? `${first} अगला लिस्टेड इवेंट है ${i.next}।` : `${first} जैसे-जैसे वेन्यू और आयोजक घोषणा करते हैं, नई लिस्टिंग रोज़ जुड़ती हैं।`;
      }
      const first = `${where} में ${period ? `${period} ` : "आगे "}${n} ${what} लिस्टेड ${hai(n)}।`;
      const second = n === 1 ? `यह है ${i.picks[0]}।`
        : `इनमें शामिल हैं ${listJoin(i.picks)}${i.free ? `; ${i.free} इवेंट में एंट्री फ़्री है` : ""}।`;
      return `${first} ${second}`;
    },
    faqs(i: FaqInput): Faq[] {
      const c = i.city;
      const n = i.count;
      const listed = (none: string) => {
        if (n === 0) return none;
        const more = n > 5 ? ` इस पेज पर ${n - 5} और ${hai(n - 5)}।` : "";
        return `${i.lines.join("; ")}।${more}`;
      };
      const booking: Faq = {
        question: "टिकट कहाँ बुक करें?",
        answer: "जहाँ बुकिंग की घोषणा हुई है, वहाँ हर लिस्टिंग में आधिकारिक बुकिंग पेज का लिंक है (जैसे District, BookMyShow या आयोजक का अपना लिंक)। Pick the Joint टिकट नहीं बेचता।",
      };
      const freeFaq = (period: string): Faq => ({
        question: `क्या ${period} ${c} में कोई फ़्री इवेंट है?`,
        answer: i.freeCount ? `हाँ, ${i.freeCount} लिस्टेड इवेंट में एंट्री फ़्री है: ${i.freeLines.join("; ")}।`
          : `${period} के किसी भी लिस्टेड इवेंट में फ़्री एंट्री दर्ज नहीं है। जहाँ आयोजक ने क़ीमत बताई है, वह हर लिस्टिंग पर दी गई है।`,
      });
      const none = (period: string) => `${c} में ${period} के लिए अभी कोई इवेंट लिस्टेड नहीं है। लिस्टिंग रोज़ अपडेट होती हैं।`;
      switch (i.kind) {
        case "today":
          return [{ question: `आज ${c} में क्या हो रहा है?`, answer: listed(none("आज")) }, freeFaq("आज"), booking];
        case "this-weekend":
          return [{ question: `इस वीकेंड ${c} में क्या हो रहा है?`, answer: listed(none("इस वीकेंड")) }, freeFaq("इस वीकेंड"), booking];
        case "category":
          return [
            { question: `क्या ${c} में कोई ${i.category} इवेंट आने वाला है?`, answer: listed(`${c} में फ़िलहाल कोई ${i.category} इवेंट लिस्टेड नहीं है। लिस्टिंग रोज़ अपडेट होती हैं।`) },
            booking,
          ];
        case "area":
          return [
            { question: `${i.area}, ${c} में कौन-से इवेंट हो रहे हैं?`, answer: listed(`${i.area} की जगहों पर फ़िलहाल कोई इवेंट लिस्टेड नहीं है। लिस्टिंग रोज़ अपडेट होती हैं।`) },
            booking,
          ];
        case "past":
          return [
            { question: `आप ${c} के पिछले इवेंट क्यों रखते हैं?`, answer: "पिछली लिस्टिंग से पता चलता है कि किसी जगह या कलाकार ने पहले क्या किया है, और हर लिस्टिंग के साथ उसका मूल स्रोत रहता है। इवेंट हो जाने के बाद कुछ भी हटाया नहीं जाता।" },
          ];
        default:
          return [
            { question: `इस हफ़्ते ${c} में करने के लिए क्या है?`, answer: listed(none("इस हफ़्ते")) },
            freeFaq("इस हफ़्ते"),
            { question: "आपको कैसे पता कि ये इवेंट सच में हो रहे हैं?", answer: "हर लिस्टिंग आयोजक या वेन्यू की अपनी घोषणा या किसी और नामित स्रोत से आती है, जिसका लिंक इवेंट पेज पर आख़िरी जाँच की तारीख़ के साथ दिया गया है। जिस जानकारी पर भरोसा नहीं होता, उसे छापने के बजाय जाँच के लिए रोक लिया जाता है।" },
            booking,
          ];
      }
    },
  },
  event: {
    cancelledLead: "रद्द।", cancelledText: "आयोजक ने बताया है कि यह इवेंट नहीं होगा।",
    postponedLead: "स्थगित।", postponedText: "आयोजक ने यह इवेंट आगे बढ़ा दिया है; नई तारीख़ की घोषणा होने तक नीचे पुरानी तारीख़ ही दी गई है।",
    over: (city: string) => `यह इवेंट हो चुका है। इसे ${city} के संग्रह के हिस्से के रूप में यहाँ रखा गया है।`,
    when: "कब", where: "कहाँ", price: "क़ीमत", performer: "कलाकार", performers: "कलाकार", organisedBy: "आयोजक", partOf: "इसका हिस्सा",
    timeNotAnnounced: " (शुरू होने का समय घोषित नहीं)",
    to: "से",
    openMaps: "Google Maps में खोलें",
    book: "आधिकारिक पेज पर बुक करें",
    bookNote: "Pick the Joint टिकट नहीं बेचता। यह लिंक आयोजक के बुकिंग पेज पर ले जाता है।",
    sideLabel: "बुकिंग और शेयर",
    addToCalendar: "कैलेंडर में जोड़ें",
    shareWhatsapp: "WhatsApp पर शेयर करें",
    about: "इस इवेंट के बारे में",
    source: "स्रोत",
    sourceInstagram: "आयोजक या वेन्यू की इंस्टाग्राम पोस्ट",
    sourceSubmitted: "आयोजक ने ख़ुद भेजा",
    sourceListing: (host: string) => `${host} पर लिस्टिंग`,
    sourceWeb: "वेब लिस्टिंग",
    lastVerified: "आख़िरी जाँच",
    mistake: "कोई ग़लती दिखी?", tellUs: "हमें बताएँ",
    moreAt: (venue: string) => `${venue} में और इवेंट`,
    moreLike: (category: string, city: string) => `${city} में और ${category} इवेंट`,
    titleLine: (title: string, venue: string | null, date: string) => `${title}${venue ? `, ${venue}` : ""} (${date})`,
    metaLead: (title: string, venue: string | null, city: string) => `${title}${venue ? `, ${venue}` : ""}, ${city}`,
    metaTail: "स्रोत और आख़िरी जाँच की तारीख़ पेज पर दी गई है।",
    imageAlt: (title: string) => `${title}: तारीख़, जगह और शहर`,
  },
  venue: {
    kicker: "वेन्यू",
    title: (name: string, where: string) => `${name}, ${where}: आने वाले इवेंट`,
    description: (name: string, where: string, address: string | null) => `${where} में ${name} के आने वाले और पिछले इवेंट${address ? `। पता: ${address}` : ""}। हर लिस्टिंग में उसके स्रोत का लिंक है।`,
    lead(name: string, type: string | null, area: string | null, city: string, state: string, upcoming: number): string {
      const count = upcoming ? `यहाँ ${upcoming} आने वाले इवेंट लिस्टेड ${hai(upcoming)}।` : "फ़िलहाल यहाँ कोई आने वाला इवेंट लिस्टेड नहीं है।";
      return `${name} ${area ? `${area}, ` : ""}${city}, ${state} में ${type ? `${type}` : "एक वेन्यू"} है। ${count}`;
    },
    address: "पता", area: "इलाक़ा", map: "नक़्शा", landmarks: "पास की पहचान", howToReach: "कैसे पहुँचें", parking: "पार्किंग", capacity: "क्षमता",
    capacityValue: (n: string) => `लगभग ${n} लोग`,
    about: (name: string) => `${name} के बारे में`,
    upcomingAt: (name: string) => `${name} में आने वाले इवेंट`,
    nothing: "इस वेन्यू पर अभी कुछ लिस्टेड नहीं है।",
    pastAt: (name: string) => `${name} के पिछले इवेंट`,
  },
  entity: {
    artists: "कलाकार", organisers: "आयोजक",
    title: (name: string) => `${name}: आने वाले इवेंट और पिछले शो`,
    description: (name: string, upcoming: number, past: number) =>
      `Pick the Joint पर ${name} के इवेंट: ${upcoming} आने वाले और ${past} पिछले, हर एक अपने स्रोत के साथ।`,
    stub: (name: string, artist: boolean, total: number, descriptor: string) =>
      `${name} ${artist ? `Pick the Joint पर लिस्टेड ${total} इवेंट में शामिल रहे हैं` : `ने Pick the Joint पर लिस्टेड ${total} इवेंट आयोजित किए हैं`}${descriptor ? ` (${descriptor})` : ""}। स्रोत मिलने पर यहाँ पूरा परिचय जोड़ा जाएगा।`,
    from: (place: string) => `${place} से`,
    genreLabel: "शैली", fromLabel: "कहाँ से",
    upcoming: "आने वाले इवेंट",
    noUpcoming: (name: string) => `${name} का फ़िलहाल कोई आने वाला इवेंट लिस्टेड नहीं है।`,
    past: "पिछले इवेंट",
    works: "चर्चित काम",
    worksNote: "हर शीर्षक उस काम के आधिकारिक प्लैटफ़ॉर्म पर ले जाता है। यहाँ कुछ भी होस्ट नहीं किया जाता।",
    onPlatform: (platform: string) => `, ${platform} पर`,
    professional: "यहाँ सिर्फ़ पेशे से जुड़ी, सार्वजनिक जानकारी दी जाती है।",
  },
  series: {
    kicker: "बार-बार होने वाला इवेंट",
    fallback: (name: string) => `${name} एक बार-बार होने वाला इवेंट है।`,
    recurrence: (text: string) => `यह ${text} होता है। `,
    listed: (n: number) => `${n} आने वाले इवेंट लिस्टेड ${hai(n)}।`,
    notAnnounced: "अगले संस्करण की तारीख़ें अभी घोषित नहीं हुई हैं।",
    description: (name: string) => `${name}: तारीख़ें, जगहें और पिछले संस्करण, हर एक अपने स्रोत के साथ।`,
    upcoming: "आने वाले", noDates: "अभी कोई आने वाली तारीख़ लिस्टेड नहीं है।", past: "पिछले संस्करण",
  },
  search: {
    title: (city: string) => `${city} में इवेंट खोजें`,
    description: (city: string) => `${city} में तारीख़, श्रेणी, इलाक़े और क़ीमत के हिसाब से इवेंट खोजें।`,
    from: "कब से", until: "कब तक", category: "श्रेणी", area: "इलाक़ा", price: "क़ीमत", any: "कोई भी", free: "फ़्री", paid: "टिकट वाले",
    submit: "इवेंट दिखाएँ",
    inArea: (area: string) => `${area} में`, fromDay: (day: string) => `${day} से`, untilDay: (day: string) => `${day} तक`,
    freeEntry: "फ़्री एंट्री", paidEntry: "टिकट वाले",
    status: (n: number, applied: string[], city: string) =>
      `${n} इवेंट ${n === 1 ? "मिला" : "मिले"}${applied.length ? `: ${applied.join(", ")}।` : `: ${city} में आगे होने वाला सब कुछ।`}`,
    empty: "इन फ़िल्टर से कोई लिस्टेड इवेंट नहीं मिला। तारीख़ों का दायरा बढ़ाकर या फ़िल्टर कम करके देखें।",
  },
  notFound: {
    title: "यह पेज यहाँ नहीं है",
    lead: "हो सकता है पेज कहीं और चला गया हो, या पता ग़लत टाइप हुआ हो।",
    button: "देखें क्या चल रहा है",
  },
};
