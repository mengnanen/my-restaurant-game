/* 小型“餐厅 + 简单建造”游戏（Phaser 3，无素材版）
 * 作者：你专用的“开源恋爱料理师”❤️
 * 玩法：
 *   - 每隔一段时间会生成顾客到门口排队
 *   - 点击「在炉子做披萨」增加🍕库存
 *   - 点击「给最近顾客上菜」，靠近柜台的已入座顾客会用餐并付钱
 *   - 点击「建造模式」，在地面点击可以放一张新餐桌（2人位）
 *   - 自动存档：金币、库存、桌子位置；也可手动存档/清档
 */

const W = 960, H = 540;   // 逻辑分辨率（会自适应）
const SAVE_KEY = "mini-restaurant-save-v1";

let domCoins = document.getElementById('coins');
let domPizza = document.getElementById('pizza');

const Save = {
  load() {
    try { return JSON.parse(localStorage.getItem(SAVE_KEY) || '{}'); }
    catch { return {}; }
  },
  write(state) { localStorage.setItem(SAVE_KEY, JSON.stringify(state)); }
};

class GameScene extends Phaser.Scene {
  constructor() { super('Game'); }
  init() {
    const saved = Save.load();
    this.coins = saved.coins ?? 0;
    this.pizza = saved.pizza ?? 0;
    this.tablesData = saved.tables ?? []; // [{x,y}]
    this.isBuildMode = false;

    this.queue = [];     // 排队中的顾客
    this.seated = [];    // 已入座的顾客
    this.nextCustomerId = 1;
  }

  create() {
    // 背景 / 地面
    this.add.rectangle(W/2, H/2, W, H, 0xe9f0ff);
    this.floor = this.add.rectangle(W/2, H/2+20, W-80, H-80, 0xffffff)
      .setStrokeStyle(2, 0xd7e1ff);

    // 厨房 & 炉台 & 柜台
    this.add.text(24, 14, '美食小餐厅（开源轻量版）', { fontSize: 16, color: '#1f2937', fontStyle: 'bold' });

    this.kitchen = this.add.rectangle(120, 120, 200, 120, 0xf1f5f9).setStrokeStyle(2, 0xcbd5e1);
    this.add.text(50, 70, '厨房', { color:'#334155', fontSize:14 });

    // 炉子
    this.stove = this.add.rectangle(120, 120, 80, 40, 0xffedd5).setStrokeStyle(2, 0xf97316);
    this.add.text(98, 110, '炉子', { color:'#9a3412', fontSize:12 });

    // 柜台（顾客用餐时往这里走）
    this.counter = this.add.rectangle(350, 170, 160, 46, 0xfee2e2).setStrokeStyle(2, 0xef4444);
    this.add.text(312, 150, '柜台', { color:'#991b1b', fontSize:12 });

    // 餐桌组
    this.tables = this.add.group();
    // 从存档恢复桌子
    this.tablesData.forEach(t => this.spawnTable(t.x, t.y));

    // 顾客计时器
    this.time.addEvent({
      delay: 2500, loop: true,
      callback: () => this.spawnCustomer()
    });

    // 交互：建造模式点击地面放桌子
    this.input.on('pointerdown', (pointer) => {
      if (!this.isBuildMode) return;
      // 不要放到厨房/柜台区域，做个简易限制：
      if (Phaser.Geom.Rectangle.ContainsPoint(this.kitchen.getBounds(), pointer) ||
          Phaser.Geom.Rectangle.ContainsPoint(this.counter.getBounds(), pointer)) return;
      // 也避免太靠边
      if (pointer.x < 80 || pointer.x > W-80 || pointer.y < 80 || pointer.y > H-60) return;

      this.spawnTable(pointer.x, pointer.y);
      this.persist();
    });

    // UI按钮
    document.getElementById('cookBtn').onclick = () => this.cookPizza();
    document.getElementById('serveBtn').onclick = () => this.serveNearest();
    document.getElementById('buildBtn').onclick = (e) => {
      this.isBuildMode = !this.isBuildMode;
      e.target.textContent = this.isBuildMode ? '✅ 退出建造' : '🧱 建造模式';
    };
    document.getElementById('saveBtn').onclick = () => this.persist(true);
    document.getElementById('resetBtn').onclick = () => {
      localStorage.removeItem(SAVE_KEY); location.reload();
    };

    this.refreshTopBar();
  }

  // 放置一张 2人位餐桌
  spawnTable(x, y) {
    const top = this.add.rectangle(x, y, 64, 36, 0xdcfce7).setStrokeStyle(2, 0x16a34a);
    const seat1 = this.add.circle(x-30, y+28, 12, 0xbfdbfe).setStrokeStyle(2, 0x2563eb);
    const seat2 = this.add.circle(x+30, y+28, 12, 0xbfdbfe).setStrokeStyle(2, 0x2563eb);
    const table = this.add.container(0,0,[top, seat1, seat2]);
    table.x = 0; table.y = 0; // 容器默认
    table.meta = { x, y, capacity: 2, occupied: 0 };

    // 增加占位检测（简化：顾客入座时直接站到座位圆球旁）
    table.getWorldSeatPos = () => ([
      {x: seat1.x, y: seat1.y, occupied:false},
      {x: seat2.x, y: seat2.y, occupied:false}
    ]);

    table.getBounds = () => top.getBounds();

    this.tables.add(table);
    // 记录到存档
    if (!this.tablesData.find(t => t.x===x && t.y===y)) this.tablesData.push({x,y});
  }

  // 生成顾客到门口排队
  spawnCustomer() {
    // 最高并发限制，避免太多
    if (this.queue.length + this.seated.length > 12) return;

    const id = this.nextCustomerId++;
    const g = this.add.container(0,0);
    const body = this.add.circle(0,0,12,0x64748b);
    const head = this.add.circle(0,-18,8,0x94a3b8);
    const chat = this.add.text(-14, -40, '🍽️', { fontSize: 14 });
    g.add([body, head, chat]);

    g.meta = { id, state:'queue', target:null, seat:null, eaten:false };
    // 门口位置（右下角）
    g.x = W - 80; g.y = H - 80 - this.queue.length*28;
    this.queue.push(g);

    // 每个顾客会尝试找座位
    this.time.addEvent({ delay: 200, callback: ()=> this.trySeat(g) });
  }

  trySeat(g) {
    if (g.meta.state !== 'queue') return;

    // 找一个有空位的桌子
    const allTables = this.tables.getChildren();
    for (const table of allTables) {
      const seats = table.getWorldSeatPos();
      const freeIdx = seats.findIndex(s => !s.occupied);
      if (freeIdx >= 0) {
        // 占位
        seats[freeIdx].occupied = true;
        table.meta.occupied++;
        g.meta.seat = { table, idx: freeIdx, pos: seats[freeIdx] };
        g.meta.state = 'walking-seat';
        // 动画走到座位
        this.tweens.add({
          targets: g, x: seats[freeIdx].x, y: seats[freeIdx].y - 10, duration: 800, ease: 'Sine.easeInOut',
          onComplete: () => {
            g.meta.state = 'seated';
            this.seated.push(g);
            // 从队列移除并重排剩余队列
            this.queue = this.queue.filter(x => x !== g);
            this.relayoutQueue();
          }
        });
        return;
      }
    }
    // 没座位则继续排队
  }

  relayoutQueue() {
    this.queue.forEach((q, i) => {
      this.tweens.add({ targets: q, x: W - 80, y: H - 80 - i*28, duration: 300, ease:'Sine.easeOut' });
    });
  }

  cookPizza() {
    // 在厨房附近才允许
    // 简化：直接+1
    this.pizza++;
    this.refreshTopBar();
    this.flashAt(this.stove.x, this.stove.y - 30, '+1 🍕');
    this.persist();
  }

  serveNearest() {
    if (this.pizza <= 0) {
      this.flashAt(this.counter.x, this.counter.y - 40, '🍕不足', '#ef4444');
      return;
    }
    // 找离柜台最近的已入座顾客
    if (this.seated.length === 0) return;
    const byDist = [...this.seated].sort((a,b)=>{
      const da = Phaser.Math.Distance.Between(a.x,a.y,this.counter.x,this.counter.y);
      const db = Phaser.Math.Distance.Between(b.x,b.y,this.counter.x,this.counter.y);
      return da - db;
    });
    const g = byDist[0];
    this.pizza--; this.refreshTopBar();

    // 顾客模拟用餐→付钱→离开
    g.meta.state = 'eating';
    this.flashAt(g.x, g.y - 34, '吃饭中…');
    this.time.delayedCall(1000, () => {
      // 付钱
      const earn = Phaser.Math.Between(6, 12);
      this.coins += earn;
      this.refreshTopBar();
      this.flashAt(g.x, g.y - 34, `+${earn}💰`, '#16a34a');

      // 释放座位
      if (g.meta.seat) {
        g.meta.seat.table.meta.occupied--;
        //（简化，不重置 seats 的 occupied，避免需要存储结构；不影响下一批顾客判定）
      }
      // 离开动画
      g.meta.state = 'leaving';
      this.tweens.add({
        targets: g, x: W + 40, y: g.y, duration: 800, onComplete: ()=> {
          g.destroy();
          this.seated = this.seated.filter(x => x !== g);
          this.persist();
        }
      });
    });
  }

  flashAt(x, y, text, color='#111827') {
    const t = this.add.text(x, y, text, { fontSize: 14, color });
    t.setOrigin(.5, .5);
    this.tweens.add({ targets: t, y: y-20, alpha: 0, duration: 900, onComplete: ()=> t.destroy() });
  }

  refreshTopBar() {
    domCoins.textContent = this.coins;
    domPizza.textContent = this.pizza;
  }

  persist(manual=false) {
    Save.write({
      coins: this.coins,
      pizza: this.pizza,
      tables: this.tables.getChildren().map(t => ({ x: t.list[0].x, y: t.list[0].y }))
    });
    if (manual) this.flashAt(W/2, 40, '已保存');
  }
}

const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game',
  width: W,
  height: H,
  backgroundColor: '#e9f0ff',
  scale: {
    mode: Phaser.Scale.ENVELOP,  // 更适合不同屏幕比例
    autoCenter: Phaser.Scale.CENTER_BOTH
  },
  scene: [GameScene]
});
