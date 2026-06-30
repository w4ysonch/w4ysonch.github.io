---
title: "嵌入式 Linux 里的设计模式"
date: 2026-03-15T14:35:41+08:00
categories: ["知识向"]
tags: ["C++", "嵌入式", "Linux", "设计模式"]
cover: /images/guides/linux-design-patterns/cover.png
top_img: false
---

写代码久了会发现一件事：很多问题的结构是重复的。协议解析要追踪"现在处理到哪一步了"，多个模块要响应同一份数据，不同类型的设备要对外提供一样的接口——这些问题换个项目换个语言还是会出现，解法也大同小异。

把这些反复出现的解法总结下来，就是设计模式。1994 年 GoF 出了一本书《Design Patterns》，归纳了 23 种模式，后来成了软件工程里的经典参考。

但设计模式不是要往代码里强行套的模板，也不是炫技用的。它只是一套命名系统——给那些"有经验的程序员都会这么写，但说不清楚叫什么"的结构起了个名字，方便沟通和复用。真正的价值在于：当你遇到一个结构性问题，能快速识别出它属于哪类，然后套用已经被验证过的解法，而不是每次都从头发明轮子。

GoF 的 23 个模式里，很多在嵌入式 Linux 开发里用不上或者用处不大。这篇只挑五个真正高频的讲：状态机、观察者、工厂、命令模式、责任链。

---

## 一、状态机（FSM）

状态机（Finite State Machine）描述的是一个系统在不同状态之间跳转的逻辑。任何时刻，系统只处于一个确定的状态；收到某个输入（事件）后，系统根据当前状态和输入决定：执行什么动作、跳转到哪个下一状态。

这三个要素构成了状态机的骨架：

- **状态（State）**：系统当前所处的阶段，用枚举表示，名字要有意义
- **事件（Event）**：触发状态转换的输入，可以是一个字节、一个信号、一次超时
- **转换（Transition）**：当前状态 + 事件 → 执行动作 + 跳转到下一状态

状态机的本质是把"条件判断"和"状态记忆"分开管理。条件判断散落在 `if-else` 里，状态记忆混在全局变量里，这两件事纠缠在一起就是维护噩梦。状态机用一个显式的状态变量把"现在在哪"和"下一步做什么"的逻辑各归其位。

### 没有状态机时，代码会变成什么样

先看一个真实场景：通过串口接收 Modbus RTU 协议的数据帧，格式是 `[从机地址 1B][功能码 1B][数据 nB][CRC 2B]`，数据长度由功能码决定。麻烦的地方在于，`read()` 每次返回的字节数不定，可能一次拿到半帧，也可能一次拿到好几帧，必须自己维护"当前解析到哪了"。

不用状态机的写法通常长这样：

```cpp
// 全局变量记录进度
static int   parse_phase  = 0;  // 0=等地址 1=等功能码 2=收数据 3=收CRC
static int   data_count   = 0;
static int   expected_len = 0;
static uint8_t frame_buf[32];

void on_byte_received(uint8_t byte) {
    if (parse_phase == 0) {
        frame_buf[0] = byte;
        parse_phase = 1;
    } else if (parse_phase == 1) {
        frame_buf[1] = byte;
        if (byte == 0x03 || byte == 0x06) {
            expected_len = 4;
            parse_phase = 2;
            data_count = 0;
        } else {
            parse_phase = 0;  // 未知功能码，重置
        }
    } else if (parse_phase == 2) {
        frame_buf[2 + data_count++] = byte;
        if (data_count >= expected_len) {
            parse_phase = 3;
            data_count = 0;
        }
    } else if (parse_phase == 3) {
        // 收 CRC...
        // 这里还要处理超时怎么办？错误恢复怎么办？
        // 代码继续膨胀...
    }
}
```

这段代码能跑，但加一个需求就要在这里打补丁。`phase` 是个裸整数，没有名字，看代码要对着注释才知道 `2` 是什么意思。更糟的是，所有状态的逻辑都堆在一个函数里，任何一处改动都可能影响到其他分支。

### 状态机的思路

状态机把"当前处于哪个阶段"显式化成一个有名字的枚举，每个状态的处理逻辑是独立的，状态之间的跳转有明确的触发条件。整个结构可以用一张图描述：

```
IDLE ──收到字节──► GOT_ADDR ──收到字节──► GOT_FUNC ──收够数据──► RECV_DATA
                                              │                       │
                                          未知功能码              收够了
                                              │                       │
                                              ▼                       ▼
                                            ERROR               GOT_CRC_LO ──收到第二字节──► 回调 → IDLE
```

对应到代码：

```cpp
#include <cstdint>
#include <vector>
#include <functional>

enum class ModbusState {
    IDLE,
    GOT_ADDR,
    GOT_FUNC,
    RECV_DATA,
    GOT_CRC_LO,
    ERROR
};

struct ModbusFrame {
    uint8_t addr;
    uint8_t func;
    std::vector<uint8_t> data;
    uint16_t crc;
};

class ModbusParser {
public:
    using FrameCallback = std::function<void(const ModbusFrame&)>;
    explicit ModbusParser(FrameCallback cb) : on_frame_(std::move(cb)) {}

    void feed(uint8_t byte) {
        switch (state_) {
        case ModbusState::IDLE:
            frame_ = {};
            frame_.addr = byte;
            state_ = ModbusState::GOT_ADDR;
            break;

        case ModbusState::GOT_ADDR:
            frame_.func = byte;
            expected_len_ = data_len_for_func(byte);
            if (expected_len_ < 0) {
                state_ = ModbusState::ERROR;
            } else {
                frame_.data.reserve(expected_len_);
                state_ = ModbusState::GOT_FUNC;
            }
            break;

        case ModbusState::GOT_FUNC:
        case ModbusState::RECV_DATA:
            frame_.data.push_back(byte);
            if (static_cast<int>(frame_.data.size()) >= expected_len_)
                state_ = ModbusState::GOT_CRC_LO;
            else
                state_ = ModbusState::RECV_DATA;
            break;

        case ModbusState::GOT_CRC_LO:
            frame_.crc = byte;
            state_ = ModbusState::ERROR;
            break;

        case ModbusState::ERROR:
            frame_.crc |= static_cast<uint16_t>(byte) << 8;
            on_frame_(frame_);
            state_ = ModbusState::IDLE;
            break;
        }
    }

    void reset() { state_ = ModbusState::IDLE; }
    ModbusState state() const { return state_; }

private:
    int data_len_for_func(uint8_t func) {
        switch (func) {
        case 0x03: return 4;
        case 0x06: return 4;
        default:   return -1;
        }
    }

    ModbusState state_ = ModbusState::IDLE;
    ModbusFrame frame_;
    int expected_len_ = 0;
    FrameCallback on_frame_;
};
```

调用侧接 `read()` 系统调用，`feed()` 每次处理一个字节，不阻塞，直接挂在 `epoll` 事件循环里没问题：

```cpp
ModbusParser parser([](const ModbusFrame& f) {
    printf("收到帧：addr=0x%02X func=0x%02X\n", f.addr, f.func);
});

uint8_t buf[64];
ssize_t n;
while ((n = read(fd, buf, sizeof(buf))) > 0) {
    for (ssize_t i = 0; i < n; i++)
        parser.feed(buf[i]);
}
```

### 这个设计的几个细节

**状态机不持有 fd。** `ModbusParser` 只接受字节输入，和文件描述符、socket、串口驱动完全解耦。好处是测试时可以直接喂一个字节数组，不需要真实硬件：

```cpp
uint8_t test_frame[] = {0x01, 0x03, 0x00, 0x00, 0x00, 0x01, 0x84, 0x0A};
for (auto b : test_frame) parser.feed(b);
```

**用回调而不是轮询。** 调用方不需要每次都检查"帧有没有解析完"，帧一旦完整就自动触发回调，设计更干净。这也是为什么构造函数接受一个 `FrameCallback`。

**错误状态需要外部超时复位。** Modbus RTU 靠帧间隔（3.5 个字符时间）判断帧边界，进入 ERROR 状态后不能自己恢复，要靠外部定时器调用 `reset()`。这个超时逻辑属于调用层的职责，不放在 parser 里。

**`enum class` 而不是裸 `int`。** 状态机的状态必须用 `enum class`，不能用 `0`、`1`、`2` 这样的裸整数。前者在任何地方都能直接看出含义，后者三个月后连作者自己都看不懂。

---

## 二、观察者（Observer）

观察者模式描述的是一种"订阅-通知"关系：一个对象（Subject，被观察者）持有一份订阅列表，当它的状态发生变化时，自动通知列表里的所有订阅者（Observer）。

这个模式解决的核心问题是**解耦**——数据的产生方不需要知道谁在关心这份数据，消费方也不需要主动去轮询。两边通过订阅关系松散地连接，互相独立演化。

现实中这个模型到处都是：新闻订阅（你订阅了某个频道，有新文章时自动推送）、前端框架里的响应式数据绑定（数据变了，页面自动更新）、Linux 里的信号机制（进程注册信号处理函数，内核发信号时调用）——本质都是观察者。

### 模块之间的依赖是怎么失控的

一个温度采集进程，读到数据之后要做三件事：更新显示、写日志、超阈值告警。最直接的写法：

```cpp
void sensor_loop() {
    while (true) {
        float temp = read_temperature();
        update_display(temp);
        write_log(temp);
        check_alarm(temp);
        sleep(1);
    }
}
```

看起来没问题。但过了两周，需求变了：要加一路数据上报到云端，要让日志只在 debug 模式下工作，要把告警逻辑移到另一个线程。每次变化都要来改 `sensor_loop()`——一个负责**采集**的函数，慢慢变成了所有下游模块的调度中心。采集和消费之间的边界消失了。

这种耦合的本质问题是：数据的产生方（采集）直接知道消费方（显示、日志、告警）的存在，并主动调用它们。如果产生方只是"广播"一条通知，消费方自己决定要不要订阅，两边就彻底分开了。这就是观察者模式要解决的问题。

### 核心结构

Subject（被观察的对象）维护一个订阅者列表，数据更新时逐个通知。Observer（观察者）提前登记，之后自动收到推送。

```cpp
#include <functional>
#include <vector>

template<typename EventT>
class Subject {
public:
    using Handler = std::function<void(const EventT&)>;

    void subscribe(Handler h) {
        handlers_.push_back(std::move(h));
    }

    void notify(const EventT& event) {
        for (auto& h : handlers_) h(event);
    }

private:
    std::vector<Handler> handlers_;
};

struct TempReading {
    int sensor_id;
    float celsius;
};
```

用模板是因为不同类型的事件（温度、湿度、按键）都有"一对多通知"的需求，`Subject<TempReading>`、`Subject<KeyEvent>` 各用各的，比写死类型灵活。

用法：

```cpp
Subject<TempReading> temp_subject;

temp_subject.subscribe([](const TempReading& r) {
    printf("[显示] sensor %d: %.1f°C\n", r.sensor_id, r.celsius);
});
temp_subject.subscribe([](const TempReading& r) {
    write_log(r.sensor_id, r.celsius);
});
temp_subject.subscribe([](const TempReading& r) {
    if (r.celsius > 80.0f)
        trigger_alarm(r.sensor_id);
});

// 采集模块，只管通知，不知道上面谁在订阅
void sensor_loop(Subject<TempReading>& subject) {
    while (true) {
        float temp = read_temperature();
        subject.notify({1, temp});
        sleep(1);
    }
}
```

加一路云端上报，只需要再 `subscribe()` 一次，`sensor_loop()` 一行代码不用动。

### 多线程场景下的问题

单线程事件循环里上面的版本就够用了。但嵌入式 Linux 里更常见的是多线程：采集线程读传感器，主线程做显示和告警。如果采集线程调用 `notify()`，回调就在采集线程里跑——回调里做了耗时操作（写文件、网络请求），会直接阻塞采集。

另一个问题是线程安全：如果采集线程 `notify()` 的同时，另一个线程在 `subscribe()`，`handlers_` 被并发读写，行为未定义。

加读写锁解决订阅和通知的并发冲突：

```cpp
#include <shared_mutex>

template<typename EventT>
class ThreadSafeSubject {
public:
    using Handler = std::function<void(const EventT&)>;

    void subscribe(Handler h) {
        std::unique_lock lock(mutex_);  // 写锁：修改列表时独占
        handlers_.push_back(std::move(h));
    }

    void notify(const EventT& event) {
        std::shared_lock lock(mutex_);  // 读锁：多个线程可以并发 notify
        for (auto& h : handlers_) h(event);
    }

private:
    std::shared_mutex mutex_;
    std::vector<Handler> handlers_;
};
```

但这还是没解决"回调在采集线程跑"的问题。如果回调里有耗时操作，正确做法是 `notify()` 只往队列里投一条事件，另一个消费线程取出来再执行回调，彻底把生产和消费隔开。这正是下一节命令模式的用法，两者可以直接组合。

### 一个容易忽略的陷阱：悬空回调

上面的实现没有取消订阅（unsubscribe）。如果订阅者对象被销毁了，但 lambda 里捕获了它的指针，再触发 `notify()` 就是悬空指针访问，通常直接崩溃。

如果需要支持取消订阅，`subscribe()` 返回一个 token，用 token 来注销：

```cpp
using Token = int;

Token subscribe(Handler h) {
    int id = next_id_++;
    handlers_.emplace_back(id, std::move(h));
    return id;
}

void unsubscribe(Token id) {
    auto it = std::remove_if(handlers_.begin(), handlers_.end(),
                             [id](const auto& e) { return e.first == id; });
    handlers_.erase(it, handlers_.end());
}

private:
    int next_id_ = 0;
    std::vector<std::pair<int, Handler>> handlers_;
```

简单场景里如果订阅者生命周期和程序一样长，不支持取消也可以。但要有意识地做这个选择，而不是不知道这个问题的存在。

---

## 三、工厂（Factory）

工厂模式解决的是对象创建的问题。听起来很简单——`new` 一个对象不就行了？问题在于，当"创建哪种对象"这个决策需要在运行时才能确定时，调用方不得不知道所有可能的类型，再用 `if-else` 判断该创建哪个。随着类型增多，这段判断逻辑变得越来越臃肿，而且每次加新类型都要改调用方。

工厂模式的思路是：把"如何创建对象"的知识封装进工厂，调用方只告诉工厂"我要一个什么类型的对象"，工厂负责决定实际创建哪个类的实例。调用方不需要 `#include` 具体类的头文件，不需要知道构造函数的参数，更不需要在自己的代码里维护一张类型判断表。

工厂有几种常见形式：

- **简单工厂**：一个静态函数，`if-else` 判断类型，适合类型数量少且固定的场景
- **工厂方法**：每个子类负责创建自己，调用方通过多态来使用
- **抽象工厂**：创建一组相关对象，保证它们配套
- **注册表工厂**：维护一张"类型字符串 → 创建函数"的映射，动态注册，扩展不需要改工厂本身

嵌入式 Linux 里最实用的是注册表工厂，因为设备类型通常从配置文件读取，在编译期不确定。

### 对象创建的逻辑为什么会泄漏

一个数据采集程序，配置文件里写了每个传感器的类型：

```ini
[sensor0]
type = sysfs_temp
path = /sys/class/thermal/thermal_zone0/temp

[sensor1]
type = iio
device = 0
```

读取配置后要根据 `type` 字段创建对应的传感器对象。最直接的写法：

```cpp
std::unique_ptr<Sensor> create_sensor(const std::string& type,
                                      const std::string& arg) {
    if (type == "sysfs_temp")
        return std::make_unique<SysfsTempSensor>(arg);
    else if (type == "iio")
        return std::make_unique<IioSensor>(std::stoi(arg));
    else
        throw std::runtime_error("unknown type");
}
```

加新传感器类型要改这个函数；这个函数要 `#include` 所有传感器的头文件；传感器的构造方式全都暴露在外面。对象的创建逻辑，从它本来该在的地方（传感器类），泄漏到了调用者里。

工厂模式把"如何创建这种对象"的知识放回到它该在的地方，对外只暴露"给我一个这种类型的对象"这个接口。

### 注册表工厂

工厂用一个注册表（类型字符串 → 创建函数）来维护所有已知类型，注册和使用完全分开：

```cpp
#include <memory>
#include <string>
#include <unordered_map>
#include <functional>
#include <stdexcept>

// 统一接口：所有传感器都要实现这两个方法
class Sensor {
public:
    virtual ~Sensor() = default;
    virtual float read() = 0;
    virtual std::string name() const = 0;
};

class SensorFactory {
public:
    using Creator = std::function<std::unique_ptr<Sensor>(const std::string&)>;

    static SensorFactory& instance() {
        static SensorFactory f;  // C++11 保证线程安全初始化
        return f;
    }

    void register_type(const std::string& type, Creator creator) {
        creators_[type] = std::move(creator);
    }

    std::unique_ptr<Sensor> create(const std::string& type,
                                   const std::string& arg) const {
        auto it = creators_.find(type);
        if (it == creators_.end())
            throw std::runtime_error("未知传感器类型: " + type);
        return it->second(arg);
    }

private:
    std::unordered_map<std::string, Creator> creators_;
};
```

传感器的实现各自在自己的类里：

```cpp
class SysfsTempSensor : public Sensor {
public:
    explicit SysfsTempSensor(std::string path) : path_(std::move(path)) {}

    float read() override {
        FILE* f = fopen(path_.c_str(), "r");
        if (!f) return -1.0f;
        int millidegree = 0;
        fscanf(f, "%d", &millidegree);
        fclose(f);
        return millidegree / 1000.0f;
    }

    std::string name() const override { return "sysfs:" + path_; }

private:
    std::string path_;
};

class IioSensor : public Sensor {
public:
    explicit IioSensor(int index) : index_(index) {}

    float read() override {
        char path[64];
        snprintf(path, sizeof(path),
                 "/sys/bus/iio/devices/iio:device%d/in_temp_raw", index_);
        FILE* f = fopen(path, "r");
        if (!f) return -1.0f;
        float val = 0;
        fscanf(f, "%f", &val);
        fclose(f);
        return val;
    }

    std::string name() const override {
        return "iio:device" + std::to_string(index_);
    }

private:
    int index_;
};
```

程序启动时集中注册，之后按类型字符串创建：

```cpp
void register_all_sensors() {
    auto& f = SensorFactory::instance();
    f.register_type("sysfs_temp", [](const std::string& path) {
        return std::make_unique<SysfsTempSensor>(path);
    });
    f.register_type("iio", [](const std::string& arg) {
        return std::make_unique<IioSensor>(std::stoi(arg));
    });
}

// 主程序
register_all_sensors();
auto sensor = SensorFactory::instance().create(
    "sysfs_temp", "/sys/class/thermal/thermal_zone0/temp");
printf("%s: %.1f°C\n", sensor->name().c_str(), sensor->read());
```

新增传感器类型：写一个新类、加一行 `register_type()`，主程序的 `create()` 调用一行不用改。

### 关于虚函数的开销

`Sensor::read()` 是虚函数，每次调用有一次通过 vtable 的间接跳转。对于每秒采集几次的传感器来说开销完全可以忽略。如果是毫秒级高频采集，可以用 CRTP（奇异递归模板模式）做静态多态，编译期决定调用哪个实现，运行时开销为零。但那是另一个话题，大多数嵌入式 Linux 传感器场景，虚函数是合适的选择。

---

## 四、命令模式（Command）

命令模式把"做一件事"封装成一个对象。听起来很绕——函数不就是"做一件事"吗？区别在于，函数调用是即时的，调用方直接执行；命令对象可以被存储、传递、排队、延迟执行，甚至撤销。

把操作变成对象，带来了几个普通函数做不到的能力：

- **延迟执行**：先把命令放入队列，稍后由另一个线程执行
- **撤销/重做**：命令对象同时保存"执行"和"反向操作"，编辑器的 Ctrl+Z 就是这个思路
- **日志和回放**：记录所有命令对象，出了问题可以重放操作序列复现 bug
- **优先级调度**：命令放进优先级队列，重要的先执行

在嵌入式 Linux 里，命令模式最常见的用法是**异步任务分发**：主线程（或事件循环）接收到请求，把要做的操作打包成命令对象，投入队列，工作线程从队列里取出来执行，主线程不被阻塞。

### 主线程被阻塞的问题

嵌入式 Linux 守护进程一个很典型的结构：主线程用 `epoll` 监听多个事件源——Unix socket 上的 IPC 请求、定时器、信号。收到请求后要执行操作：读传感器、写配置、重启子系统。

如果在事件回调里直接执行这些操作，主线程就被占住了，期间新到的事件全部堆积，实时性变差：

```cpp
// 问题写法：主线程在回调里直接做耗时操作
void on_ipc_request(int client_fd) {
    Request req = parse_request(client_fd);
    if (req.type == "read_sensor") {
        float val = read_sensor_blocking();  // 可能耗时几百毫秒
        send_response(client_fd, val);
    }
    // 这段时间里其他 fd 上的事件全部被阻塞
}
```

正确的做法是：主线程只负责接收请求、打包成任务，扔给工作线程执行，自己立刻返回继续处理下一个事件。

命令模式把"要做什么"封装成一个可传递的对象，和"谁来执行、什么时候执行"分开。

### 实现

命令最简单的形式就是 `std::function<void()>`，lambda 捕获执行所需的上下文。配合线程安全队列：

```cpp
#include <functional>
#include <queue>
#include <mutex>
#include <condition_variable>
#include <thread>
#include <atomic>

using Command = std::function<void()>;

class CommandQueue {
public:
    void push(Command cmd) {
        {
            std::lock_guard lock(mutex_);
            queue_.push(std::move(cmd));
        }
        cv_.notify_one();
    }

    // 工作线程调用，没有命令时阻塞等待
    bool pop(Command& cmd) {
        std::unique_lock lock(mutex_);
        cv_.wait(lock, [this] { return !queue_.empty() || stop_; });
        if (queue_.empty()) return false;
        cmd = std::move(queue_.front());
        queue_.pop();
        return true;
    }

    void stop() {
        stop_ = true;
        cv_.notify_all();
    }

private:
    std::queue<Command> queue_;
    std::mutex mutex_;
    std::condition_variable cv_;
    std::atomic<bool> stop_{false};
};

class Worker {
public:
    explicit Worker(CommandQueue& q) : queue_(q) {
        thread_ = std::thread([this] {
            Command cmd;
            while (queue_.pop(cmd)) cmd();
        });
    }

    ~Worker() {
        queue_.stop();
        if (thread_.joinable()) thread_.join();
    }

private:
    CommandQueue& queue_;
    std::thread thread_;
};
```

主线程的事件回调变成：

```cpp
CommandQueue queue;
Worker worker(queue);

void on_ipc_request(int client_fd) {
    Request req = parse_request(client_fd);
    if (req.type == "read_sensor") {
        // lambda 捕获 client_fd，打包成命令，立刻返回
        queue.push([client_fd] {
            float val = read_sensor_blocking();
            send_response(client_fd, val);
        });
    }
}
```

主线程不再被阻塞，`read_sensor_blocking()` 在工作线程里执行。

### 需要拿到执行结果时

有些操作需要返回值，用 `std::packaged_task` 和 `std::future` 配合：

```cpp
template<typename F>
auto submit(CommandQueue& queue, F func) -> std::future<decltype(func())> {
    auto task = std::make_shared<std::packaged_task<decltype(func())()>>(func);
    auto future = task->get_future();
    queue.push([task] { (*task)(); });
    return future;
}

// 主线程提交任务，拿到 future，需要结果时再等
auto future = submit(queue, [] { return read_sensor_blocking(); });
// 继续处理其他事件...
float val = future.get();  // 这里才真正等待
```

### 这个模式和直接开线程有什么区别

每来一个请求就开一个线程处理也能解决主线程阻塞——但线程创建有开销，并发线程数不可控，共享资源的竞争也变复杂。

命令队列是单个工作线程（或固定大小的线程池）消费所有命令，并发度可控，命令天然串行执行，不需要额外同步。嵌入式场景里资源有限，不希望无限制并发，用命令队列更合适。

---

## 五、责任链（Chain of Responsibility）

责任链模式把一系列处理步骤组织成链条，请求（数据）从链头进入，依次经过每一个处理器。每个处理器只关心自己那一步，处理完之后决定：把数据传给下一个处理器，还是到此为止（丢弃或终止）。

这个模式最直观的类比是流水线——汽车在流水线上依次经过冲压、焊接、喷漆、检验，每个工位只做自己负责的事，不需要知道其他工位的存在。和流水线不同的地方是，责任链的任意一个节点可以决定"这个产品不合格，到这里停掉"，后面的节点不再执行。

这和直接写一个处理函数的本质区别是**职责分离**：

- 一个函数里写所有处理逻辑，改一处可能影响全部
- 责任链里每个处理器独立，可以单独测试、单独替换、随时插拔

现实中这个模式也到处可见：HTTP 框架的中间件（请求经过认证、限流、日志、路由，任意一个中间件可以拦截请求）、Linux 内核的 netfilter（数据包经过 PREROUTING、FORWARD、POSTROUTING 等钩子）、日志系统的过滤器链——都是责任链。

### 数据处理流水线的问题

传感器采集到的原始数据，要经过几道处理才能用：ADC 原始值转成物理量（校准），滑动平均消抖（滤波），检查是否在合理范围内（校验），最后上报。

直接写成一个函数：

```cpp
std::optional<float> process(float raw) {
    float val = raw * 0.1f - 40.0f;  // 校准

    // 滤波
    static std::vector<float> buf;
    buf.push_back(val);
    if (buf.size() > 5) buf.erase(buf.begin());
    float sum = 0;
    for (float v : buf) sum += v;
    val = sum / buf.size();

    if (val < -40.0f || val > 125.0f) return std::nullopt;  // 校验

    report(val);  // 上报
    return val;
}
```

能跑，但这个函数承担了太多职责。想调整滤波窗口大小，想在校验和上报之间插一步单位换算，想在某些传感器上跳过滤波——每次都要改这个函数，而且改一处很容易影响到另一处。

责任链把每一步处理做成独立的处理器，串成链条，数据从链头进去依次经过每个处理器。任意一个处理器可以决定"到此为止"，后面的处理器不再执行。

### 实现

```cpp
#include <memory>
#include <optional>
#include <vector>

struct SensorData {
    int   sensor_id;
    float raw_value;
    float value;
    bool  valid = false;
};

class DataHandler {
public:
    virtual ~DataHandler() = default;
    virtual std::optional<SensorData> handle(SensorData data) = 0;

    // 返回下一个处理器的裸指针，方便链式调用组装
    DataHandler* set_next(std::unique_ptr<DataHandler> next) {
        next_ = std::move(next);
        return next_.get();
    }

protected:
    std::optional<SensorData> pass(SensorData data) {
        if (next_) return next_->handle(data);
        return data;  // 链尾，直接返回
    }

private:
    std::unique_ptr<DataHandler> next_;
};

class CalibrationHandler : public DataHandler {
public:
    CalibrationHandler(float scale, float offset)
        : scale_(scale), offset_(offset) {}

    std::optional<SensorData> handle(SensorData data) override {
        data.value = data.raw_value * scale_ + offset_;
        return pass(data);
    }

private:
    float scale_, offset_;
};

class MovingAverageHandler : public DataHandler {
public:
    explicit MovingAverageHandler(int window) : window_(window) {}

    std::optional<SensorData> handle(SensorData data) override {
        buf_.push_back(data.value);
        if (static_cast<int>(buf_.size()) > window_)
            buf_.erase(buf_.begin());
        float sum = 0;
        for (float v : buf_) sum += v;
        data.value = sum / buf_.size();
        return pass(data);
    }

private:
    int window_;
    std::vector<float> buf_;
};

// 返回 nullopt 表示数据被丢弃，链中断
class RangeValidator : public DataHandler {
public:
    RangeValidator(float min, float max) : min_(min), max_(max) {}

    std::optional<SensorData> handle(SensorData data) override {
        if (data.value < min_ || data.value > max_) {
            printf("[校验] %.2f 超出范围，丢弃\n", data.value);
            return std::nullopt;
        }
        data.valid = true;
        return pass(data);
    }

private:
    float min_, max_;
};

class ReportHandler : public DataHandler {
public:
    std::optional<SensorData> handle(SensorData data) override {
        printf("[上报] sensor=%d value=%.2f\n", data.sensor_id, data.value);
        return pass(data);
    }
};
```

组装链并使用：

```cpp
auto chain = std::make_unique<CalibrationHandler>(0.1f, -40.0f);
auto* avg  = chain->set_next(std::make_unique<MovingAverageHandler>(5));
auto* rng  = avg->set_next(std::make_unique<RangeValidator>(-40.0f, 125.0f));
rng->set_next(std::make_unique<ReportHandler>());

SensorData raw{.sensor_id = 1, .raw_value = 650.0f};
if (!chain->handle(raw).has_value())
    printf("数据无效\n");
```

### 几个设计细节

**`set_next()` 返回裸指针。** 链头用 `unique_ptr` 管理，但 `set_next()` 返回 `DataHandler*`，是为了能链式调用组装，不需要额外的中间变量：

```cpp
chain->set_next(...)->set_next(...)->set_next(...);
```

如果返回 `unique_ptr&`，调用者还需要从中取出裸指针才能继续链式调用，多此一举。

**`std::optional` 表达中断语义。** 返回 `nullopt` 表示"这条数据到此结束"，比用异常或特殊返回值更清晰。调用者一行 `has_value()` 检查就知道数据是否被丢弃了。

**每个处理器可以独立测试。** 不需要跑完整条链：

```cpp
CalibrationHandler cal(0.1f, -40.0f);
auto result = cal.handle({1, 650.0f});
assert(result.has_value());
assert(std::abs(result->value - 25.0f) < 0.001f);  // 650 × 0.1 - 40 = 25
```

**链的所有权由链头的 `unique_ptr` 管理。** 链头析构时，`next_` 析构，触发下一个节点析构，整条链依次销毁，不需要手动释放。

---

## 总结

这五个模式覆盖了嵌入式 Linux 里几类最常见的结构性问题：

| 模式 | 解决的问题 | 核心机制 |
|------|-----------|---------|
| 状态机 | 有阶段性的流程，避免条件分支爆炸 | 状态枚举 + 转换函数，每次只处理当前状态的输入 |
| 观察者 | 数据产生和消费解耦，一对多通知 | Subject 维护订阅列表，`notify()` 逐个回调 |
| 工厂 | 对象创建逻辑不泄漏到调用方 | 注册表映射类型字符串到创建函数 |
| 命令模式 | 操作的发起和执行解耦，支持异步和排队 | `std::function` 封装操作，队列在线程间传递 |
| 责任链 | 顺序处理步骤拆成独立环节，任意一步可中断 | 链式 `unique_ptr`，`std::optional` 表达中断语义 |

每个模式都有代价：多了一层抽象，代码量增加，关系更间接。判断标准很简单：用了之后，改需求是更容易了还是更难了？如果更难了，说明这个模式用错了地方。
