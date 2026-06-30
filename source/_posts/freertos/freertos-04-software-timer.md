---
title: "FreeRTOS 学习笔记（四）：软件定时器"
date: 2025-08-22T16:29:31+08:00
categories: ["FreeRTOS"]
tags: ["FreeRTOS", "RTOS", "嵌入式"]
cover: /images/FreeRTOS_note/image.png
top_img: false
---

硬件定时器有限——STM32F4 总共 14 个，去掉基本定时器和被 PWM/编码器占用的，空闲的不多。当你需要七八个周期性动作（100ms 读传感器、500ms 喂狗、2s 上报状态、10ms 按键扫描），又不想每个都起一个任务，软件定时器是最好的选择。

FreeRTOS 的软件定时器靠"定时器服务任务"在后台跑，底层依赖 `vTaskIncrementTick()` 驱动。精度取决于 tick 频率——`configTICK_RATE_HZ=1000` 时最小分辨率 1ms，`100` 时只有 10ms。

---

创建定时器：

```c
TimerHandle_t xTimerCreate(
    const char *     pcTimerName,      // 调试用
    TickType_t       xTimerPeriod,     // 周期，单位 tick 不是 ms
    UBaseType_t      uxAutoReload,     // pdTRUE=周期，pdFALSE=单次
    void *           pvTimerID,        // 附加数据，回调里能拿到
    TimerCallbackFunction_t pxCallbackFunction
);
```

两个关键参数：`xTimerPeriod` 用 `pdMS_TO_TICKS(500)` 换算，不要直接填 `500`。`uxAutoReload` 为 `pdTRUE` 定时器自动重来，`pdFALSE` 触发一次就停。

---

启动和控制：

```c
// 启动（已启动的话先重置再启动）
xTimerStart(TimerHandle_t xTimer, TickType_t xTicksToWait);
xTimerStartFromISR(TimerHandle_t xTimer, BaseType_t *pxHigherPriorityTaskWoken);

// 停止
xTimerStop(TimerHandle_t xTimer, TickType_t xTicksToWait);
xTimerStopFromISR(TimerHandle_t xTimer, BaseType_t *pxHigherPriorityTaskWoken);

// 重置——把计数清零从头开始。适用于"收到数据就推迟超时"
xTimerReset(TimerHandle_t xTimer, TickType_t xTicksToWait);
xTimerResetFromISR(TimerHandle_t xTimer, BaseType_t *pxHigherPriorityTaskWoken);

// 改周期——运行时动态调，不用先停再启
xTimerChangePeriod(TimerHandle_t xTimer, TickType_t xNewPeriod, TickType_t xTicksToWait);
xTimerChangePeriodFromISR(TimerHandle_t xTimer, TickType_t xNewPeriod, BaseType_t *pxHigherPriorityTaskWoken);

// 查状态
xTimerIsTimerActive(TimerHandle_t xTimer);
```

`xTicksToWait` 是等定时器命令队列有空位的时间。ISR 版本用 `FromISR`，不阻塞。

---

定时器回调的上下文。

回调不在你启动定时器的任务里跑，它在**定时器服务任务**的栈上执行。

```c
void MyTimerCallback(TimerHandle_t xTimer) {
    // ⚠️ 当前上下文：Timer Service Task
    // ⚠️ 不是你创建定时器的那个任务
    // ⚠️ TickType_t period = xTimerGetPeriod(xTimer);
    // ⚠️ void *id = pvTimerGetTimerID(xTimer);
}
```

这意味着回调里：

- ❌ 不能 `vTaskDelay`、不能 `xQueueReceive(portMAX_DELAY)`、不能 `xSemaphoreTake(portMAX_DELAY)`
- ❌ 不能干重活——串口打印、Flash 写入、阻塞 I2C
- ✅ 可以 `xQueueSend`（非阻塞）、`xSemaphoreGive`、`xTaskNotifyGive`
- ✅ 可以 `xQueueSendFromISR`（定时器回调的上下文对任务来说类似 ISR）

```c
// ❌ 回调里干重活
void BadCallback(TimerHandle_t t) {
    vTaskDelay(pdMS_TO_TICKS(100));  // 卡住整个定时器服务
    Hal_UART_Transmit(&huart2, buf, 128, 1000); // 可能阻塞 100ms+
}

// ✅ 回调只发通知，实际工作在任务里做
void GoodCallback(TimerHandle_t t) {
    BaseType_t woken = pdFALSE;
    xSemaphoreGiveFromISR(g_do_work, &woken);
    portYIELD_FROM_ISR(woken);
}
```

---

完整例子：定时传感器采集 + 看门狗，两个定时器配合两个任务。

```c
#include "FreeRTOS.h"
#include "task.h"
#include "timers.h"
#include "queue.h"

QueueHandle_t g_sensor_cmd_queue;

// 定时器回调——只发命令，不处理数据
void vSensorTimerCallback(TimerHandle_t xTimer) {
    BaseType_t woken = pdFALSE;
    uint8_t cmd = 0x01;
    xQueueSendFromISR(g_sensor_cmd_queue, &cmd, &woken);
    portYIELD_FROM_ISR(woken);
}

// 看门狗——检查空闲任务是否还在跑
void vWatchdogTimerCallback(TimerHandle_t xTimer) {
    static uint32_t last_feed = 0;
    uint32_t now = xTaskGetTickCount();
    if (now - last_feed > pdMS_TO_TICKS(5000)) {
        HAL_NVIC_SystemReset();  // 5 秒没喂，重启
    }
}

// 喂狗任务（最高优先级，证明系统活着）
void vFeedDogTask(void *pv) {
    while (1) {
        HAL_IWDG_Refresh(&hiwdg);
        vTaskDelay(pdMS_TO_TICKS(500));
    }
}

// 传感器处理任务
void vSensorProcTask(void *pv) {
    uint8_t cmd;
    while (1) {
        if (xQueueReceive(g_sensor_cmd_queue, &cmd, portMAX_DELAY) == pdTRUE) {
            float temp = ReadTemperature();
            int hum = ReadHumidity();
            if (temp > 85.0f) {
                // 超温告警：发事件给告警任务
                xTaskNotifyGive(g_alarm_task_handle);
            }
        }
    }
}

int main(void) {
    HAL_Init();
    SystemClock_Config();

    g_sensor_cmd_queue = xQueueCreate(4, sizeof(uint8_t));

    TimerHandle_t sensor_timer = xTimerCreate(
        "Sensor", pdMS_TO_TICKS(500), pdTRUE, (void *)0, vSensorTimerCallback
    );
    TimerHandle_t wdog_timer = xTimerCreate(
        "WDT", pdMS_TO_TICKS(1000), pdTRUE, (void *)0, vWatchdogTimerCallback
    );

    xTaskCreate(vSensorProcTask, "SensorProc", 512, NULL, 2, NULL);
    xTaskCreate(vFeedDogTask, "FeedDog", 128, NULL, 5, NULL);

    xTimerStart(sensor_timer, 0);
    xTimerStart(wdog_timer, 0);

    vTaskStartScheduler();
    while (1);
}
```

---

软件定时器的内核实现。

`xTimerStart` 不直接操作定时器，而是往一个叫"定时器命令队列"的内部队列发消息。定时器服务任务轮询这个队列，取出命令后修改定时器状态。

```
xTimerStart(timer, 100ms, 0)
       │
       ▼
  往 Timer Command Queue 发 "START 命令" ──┐
       │                                    │
       ▼                                    │
  Timer Service Task 取下一条命令 ◄─────────┘
       │
       ▼
  把 timer 加入活跃列表（按到期时间排序）
       │
       ▼
  每个 tick 中断检查列表头部的定时器到没到
       │
       ▼
  到了 → 回调在 Timer Service Task 里执行
  autoReload=true → 重新插回列表
  autoReload=false → 移出列表
```

这意味着两点：

第一，所有 `xTimerStart/Stop/Reset` 都要通过这个命令队列。一次 tick 只能处理一条命令。如果你在一个 tick 内连续发 100 条命令，命令队列会被打满。`configTIMER_QUEUE_LENGTH` 默认 10。

第二，回调是由定时器服务任务串行执行的。如果回调 A 跑了 10ms，回调 B 本来应该在同一个 tick 触发，就要等 A 跑完。这就是为什么回调里不能阻塞。

---

精度和抖动。

设定时器周期 1.5ms，`configTICK_RATE_HZ=1000`（1ms tick）：实际触发最早在 2ms。因为 tick 是离散的——定时器只在 tick 中断里被检查。

设定时器周期 10ms，`configTICK_RATE_HZ=100`（10ms tick）：实际触发最早在 10ms，最迟 20ms（取决于你刚过了一个 tick 还是刚好错过一个）。抖动 ±10ms。

一个项目里的分工：
```
软件定时器：按键去抖、状态机轮询、日志心跳、看门狗
硬件定时器：PWM、编码器捕获、精准延时、电机 FOC
```

---

`FreeRTOSConfig.h` 配置项：

```c
#define configUSE_TIMERS              1
#define configTIMER_TASK_PRIORITY     2
#define configTIMER_QUEUE_LENGTH      10
#define configTIMER_TASK_STACK_DEPTH  256
```

定时器服务任务优先级怎么定：**比需要它服务的任务高，比硬实时任务低**。假设你系统里有 PWM 控制任务（prio 5）、传感器任务（prio 3）、日志任务（prio 1），定时器服务设 prio 4——回调及时执行，但不打断 PWM。

---

几个坑。

**回调里 printf 导致连锁超时** 第一次在回调里打日志，串口 115200 bps 下一条 50 字节日志耗时约 4ms。5 个定时器同时到期，串行执行回调，最后一个延迟 20ms。修法：回调里只发队列，日志任务再输出。

**创建后忘了 Start** 比想象中常见。`xTimerCreate` 返回非 NULL 不代表定时器在跑。自己调试时"定时器不工作"第一件事：检查是不是没调 `xTimerStart`。

**单次定时器触发后还在列表里？** `uxAutoReload=pdFALSE` 触发一次后自动停止，不用手动 Stop。但如果在回调里调了 `xTimerStart` 或 `xTimerChangePeriod`，它会重新激活——这就是"动态间隔"的用法。

D**Delete 的时机** `xTimerDelete` 会等当前回调执行完再回收内存。删一个正在跑的定时器不会打断它的回调——但不建议在回调里删自己，行为依赖版本。

---

定时器 vs 任务，什么时候用哪个。

| 场景 | 软件定时器 | 任务 |
|------|------|------|
| 单一周期动作 | ✅ | 浪费栈（128~256 bytes） |
| 需要阻塞等数据 | ❌ 回调不能阻塞 | ✅ |
| 高精度时序 | ❌ tick 精度 | ❌ 硬件定时器 |
| 10 个以上周期动作 | ✅ 省 RAM | ❌ 10 个任务栈爆炸 |
| 需要维护状态机 | 不太方便 | ✅ 任务内 `switch` |

一个判断标准：如果你写了个任务，里面只有一个 `vTaskDelay` + 不到 10 行逻辑，换成软件定时器。
